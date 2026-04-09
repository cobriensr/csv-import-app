import { parse } from 'csv-parse/sync';
import { randomUUID, createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  validateRow,
  validateGroups,
  type RawRow,
  type ValidationContext,
} from './validators';
import type { ParsedRow, RejectionIssue } from '../../shared/types';

export type ImportResult = {
  import_id: string;
  filename: string;
  status: 'completed';
  row_counts: {
    total: number;
    imported: number;
    rejected: number;
  };
};

const REQUIRED_HEADERS = [
  'date',
  'reference',
  'account_code',
  'debit',
  'credit',
  'description',
  'memo',
] as const;

type RejectedRowRecord = {
  row_number: number;
  raw_row: string;
  issues: RejectionIssue[];
};

/**
 * Compute the SHA-256 hash of an uploaded CSV buffer. This is the
 * idempotency key: uploading the same file twice returns the existing
 * import_id instead of creating a duplicate row.
 */
export function computeFileHash(buffer: Buffer | string): string {
  const hash = createHash('sha256');
  hash.update(buffer);
  return hash.digest('hex');
}

/**
 * Quickly parse only the header row of a CSV and validate that it has every
 * required column. Called synchronously at POST time so the client gets an
 * immediate 400 response for malformed files rather than waiting for async
 * processing to discover the problem.
 *
 * Throws on missing headers, unparseable CSV, or empty files.
 */
export function validateCsvHeaders(buffer: Buffer | string): void {
  let records: Record<string, string>[];
  try {
    records = parse(buffer, {
      columns: true,
      skip_empty_lines: true,
      to: 1, // just the first data row — enough to get column keys
      trim: false,
      relax_column_count: true,
    }) as Record<string, string>[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse CSV: ${msg}`);
  }

  if (records.length === 0) {
    throw new Error('CSV file contains no data rows');
  }

  const firstRow = records[0]!;
  for (const header of REQUIRED_HEADERS) {
    if (!(header in firstRow)) {
      throw new Error(
        `CSV is missing required column "${header}". ` +
          `Expected columns: ${REQUIRED_HEADERS.join(', ')}`,
      );
    }
  }
}

/**
 * Create (or reuse) an import row in 'processing' state.
 *
 * Idempotency: if an import with the same file_hash already exists, we
 * return its id instead of inserting a new row. The exception is imports
 * in 'failed' state — we delete those and let the caller try again fresh,
 * since a failed import usually indicates a transient problem the user
 * wants to retry.
 *
 * Returns { importId, isDuplicate } where isDuplicate=true means the caller
 * should NOT run processImport (the work is already done or in flight).
 */
export function createImportRow(
  db: Database.Database,
  filename: string,
  fileHash: string,
): { importId: string; isDuplicate: boolean } {
  const existing = db
    .prepare('SELECT id, status FROM imports WHERE file_hash = ?')
    .get(fileHash) as { id: string; status: string } | undefined;

  if (existing) {
    if (existing.status === 'failed') {
      // Previous attempt failed — clear it so the caller can retry fresh.
      db.prepare('DELETE FROM imports WHERE id = ?').run(existing.id);
    } else {
      // Already completed or still processing — return the existing id.
      return { importId: existing.id, isDuplicate: true };
    }
  }

  const importId = `imp_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const createdAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO imports (id, filename, file_hash, status, created_at)
     VALUES (?, ?, ?, 'processing', ?)`,
  ).run(importId, filename, fileHash, createdAt);

  return { importId, isDuplicate: false };
}

/**
 * Process a CSV for an existing import row (in 'processing' state).
 *
 * This is the async-friendly core: it takes an already-created import_id,
 * validates every row and group, and atomically writes the results to the
 * database. On success, updates the import row to 'completed' with counts.
 * On failure, updates the import row to 'failed' with the error message.
 *
 * This function is designed to be called from setImmediate in the route
 * handler, so the POST /api/imports response can return 202 Accepted
 * immediately without blocking on CSV processing.
 */
export function processImport(
  db: Database.Database,
  importId: string,
  csvBuffer: Buffer | string,
): void {
  try {
    // --- Parse the CSV ---
    let records: Record<string, string>[];
    try {
      records = parse(csvBuffer, {
        columns: true,
        skip_empty_lines: true,
        trim: false,
        relax_column_count: true,
      }) as Record<string, string>[];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse CSV: ${msg}`);
    }

    if (records.length === 0) {
      throw new Error('CSV file contains no data rows');
    }

    const firstRow = records[0]!;
    for (const header of REQUIRED_HEADERS) {
      if (!(header in firstRow)) {
        throw new Error(
          `CSV is missing required column "${header}". ` +
            `Expected columns: ${REQUIRED_HEADERS.join(', ')}`,
        );
      }
    }

    // --- Build validation context from the seeded chart of accounts ---
    const accountRows = db.prepare('SELECT code FROM accounts').all() as {
      code: string;
    }[];
    const ctx: ValidationContext = {
      knownAccountCodes: new Set(accountRows.map((a) => a.code)),
    };

    // --- Row-level validation pass ---
    const validRows: ParsedRow[] = [];
    const rejectedRows: RejectedRowRecord[] = [];

    records.forEach((record, index) => {
      const row_number = index + 2; // +1 for header row, +1 for 1-indexing
      const raw: RawRow = {
        row_number,
        date: record.date ?? '',
        reference: record.reference ?? '',
        account_code: record.account_code ?? '',
        debit: record.debit ?? '',
        credit: record.credit ?? '',
        description: record.description ?? '',
        memo: record.memo ?? '',
        raw_row: REQUIRED_HEADERS.map((h) => record[h] ?? '').join(','),
      };

      const result = validateRow(raw, ctx);
      if (result.ok) {
        validRows.push(result.row);
      } else {
        rejectedRows.push({
          row_number,
          raw_row: raw.raw_row,
          issues: result.issues,
        });
      }
    });

    // --- Group-level validation ---
    const groupIssueMap = validateGroups(validRows);
    const reallyGoodRows: ParsedRow[] = [];
    for (const row of validRows) {
      const gIssues = groupIssueMap.get(row.row_number);
      if (gIssues && gIssues.length > 0) {
        rejectedRows.push({
          row_number: row.row_number,
          raw_row: row.raw_row,
          issues: gIssues,
        });
      } else {
        reallyGoodRows.push(row);
      }
    }

    rejectedRows.sort((a, b) => a.row_number - b.row_number);

    const totalRows = records.length;
    const importedCount = reallyGoodRows.length;
    const rejectedCount = rejectedRows.length;
    const completedAt = new Date().toISOString();

    // --- Atomic write: update imports row + insert transactions + rejected ---
    const write = db.transaction(() => {
      db.prepare(
        `UPDATE imports
         SET status = 'completed',
             total_rows = ?,
             imported_rows = ?,
             rejected_rows = ?,
             completed_at = ?
         WHERE id = ?`,
      ).run(totalRows, importedCount, rejectedCount, completedAt, importId);

      const insertTxn = db.prepare(
        `INSERT INTO transactions
           (import_id, row_number, reference, txn_date, account_code,
            debit_cents, credit_cents, description, memo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const row of reallyGoodRows) {
        insertTxn.run(
          importId,
          row.row_number,
          row.reference,
          row.txn_date,
          row.account_code,
          row.debit_cents,
          row.credit_cents,
          row.description,
          row.memo,
        );
      }

      const insertRejected = db.prepare(
        `INSERT INTO rejected_rows (import_id, row_number, raw_row)
         VALUES (?, ?, ?)`,
      );
      const insertIssue = db.prepare(
        `INSERT INTO rejection_issues
           (rejected_row_id, category, code, field, message, context_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const rejected of rejectedRows) {
        const info = insertRejected.run(
          importId,
          rejected.row_number,
          rejected.raw_row,
        );
        const rejectedRowId = Number(info.lastInsertRowid);
        for (const issue of rejected.issues) {
          insertIssue.run(
            rejectedRowId,
            issue.category,
            issue.code,
            issue.field,
            issue.message,
            issue.context ? JSON.stringify(issue.context) : null,
          );
        }
      }
    });

    write();
  } catch (err) {
    // Mark the import as failed so the client's poll loop sees the error.
    // We do this outside the transaction so it runs even after rollback.
    const message = err instanceof Error ? err.message : String(err);
    try {
      db.prepare(
        `UPDATE imports
         SET status = 'failed',
             error_message = ?,
             completed_at = ?
         WHERE id = ?`,
      ).run(message, new Date().toISOString(), importId);
    } catch {
      // If even the failure update fails, there's nothing more we can do.
      // Re-throwing the original error below surfaces the real problem.
    }
    throw err;
  }
}

/**
 * Execute a ledger import end to end, synchronously.
 *
 * This is the convenience wrapper used by tests and any caller that wants
 * the full result immediately. For the async HTTP flow, routes should call
 * createImportRow + processImport separately so the 202 response can return
 * before processing finishes.
 *
 * If the file_hash matches an existing completed import, this function
 * returns the existing row's data without reprocessing (idempotency).
 */
export function runImport(
  db: Database.Database,
  filename: string,
  csvBuffer: Buffer | string,
): ImportResult {
  const fileHash = computeFileHash(csvBuffer);
  const { importId, isDuplicate } = createImportRow(db, filename, fileHash);

  if (!isDuplicate) {
    processImport(db, importId, csvBuffer);
  }

  const row = db
    .prepare(
      `SELECT id, filename, status, total_rows, imported_rows, rejected_rows
       FROM imports WHERE id = ?`,
    )
    .get(importId) as {
    id: string;
    filename: string;
    status: string;
    total_rows: number;
    imported_rows: number;
    rejected_rows: number;
  };

  return {
    import_id: row.id,
    filename: row.filename,
    status: 'completed',
    row_counts: {
      total: row.total_rows,
      imported: row.imported_rows,
      rejected: row.rejected_rows,
    },
  };
}
