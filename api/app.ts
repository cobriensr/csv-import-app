import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import multer from 'multer';
import type Database from 'better-sqlite3';
import {
  computeFileHash,
  createImportRow,
  processImport,
  validateCsvHeaders,
} from './engine/import';
import type {
  ApiErrorBody,
  ApiErrorCode,
  ImportListResponse,
  ImportResource,
  ImportStatus,
  RejectedListResponse,
  RejectedRow,
  RejectionIssue,
  SummaryResponse,
  Transaction,
  TransactionListResponse,
  ValidationCategory,
} from '../shared/types';

// ---------------------------------------------------------------------------
// DB row types (raw shapes pulled straight from prepared statements). Kept
// local to this file because they are an HTTP-layer concern — the engine and
// shared types file don't need to know about them.
// ---------------------------------------------------------------------------

type ImportRow = {
  id: string;
  filename: string;
  status: ImportStatus;
  total_rows: number;
  imported_rows: number;
  rejected_rows: number;
  created_at: string;
  completed_at: string | null;
  error_message: string | null;
};

// Variant used by GET /api/imports list queries, which SELECT rowid AS
// _cursor so the opaque cursor can be returned without exposing it on the
// API response body.
type ImportRowWithCursor = ImportRow & { _cursor: number };

type TransactionRow = {
  id: number;
  row_number: number;
  reference: string;
  txn_date: string;
  account_code: string;
  debit_cents: number;
  credit_cents: number;
  description: string | null;
  memo: string | null;
};

type RejectedRowDbRow = {
  id: number;
  row_number: number;
  raw_row: string;
};

type RejectionIssueRow = {
  category: ValidationCategory;
  code: string;
  field: string | null;
  message: string;
  context_json: string | null;
};

type ByCategoryRow = {
  category: ValidationCategory;
  n: number;
};

type ByCodeRow = {
  code: string;
  category: ValidationCategory;
  n: number;
  message: string;
};

const IMPORT_SELECT_COLUMNS = `id, filename, status, total_rows, imported_rows,
       rejected_rows, created_at, completed_at, error_message`;

// Allowed values for the ?category filter on GET /api/imports/:id/rejected.
// Kept module-scoped so the validator and the error message share one source.
const VALID_CATEGORIES: readonly ValidationCategory[] = [
  'structural',
  'referential',
  'business',
];

// MIME types we accept for CSV uploads. Browsers are inconsistent about what
// they send — some use text/csv, some use application/vnd.ms-excel, and a
// handful fall back to application/octet-stream. We also accept anything
// whose filename ends in .csv as a belt-and-braces check.
const ALLOWED_CSV_MIME_TYPES = new Set<string>([
  'text/csv',
  'application/vnd.ms-excel',
  'application/octet-stream',
]);

// Sentinel prefix used to mark a multer fileFilter rejection as a MIME-type
// error (vs. a generic runtime failure). Multer surfaces this in err.message,
// which we inspect in the error-translation middleware below.
const UNSUPPORTED_MEDIA_TYPE_MARKER = 'UNSUPPORTED_MEDIA_TYPE:';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Send a standard error envelope. All non-2xx responses go through this so
 * the frontend can rely on `body.error.code` being present and typed.
 */
function sendError(
  res: Response,
  status: number,
  code: ApiErrorCode,
  message: string,
  details?: unknown,
): void {
  const body: ApiErrorBody = {
    error:
      details === undefined ? { code, message } : { code, message, details },
  };
  res.status(status).json(body);
}

/**
 * Map a raw imports-table row to the canonical ImportResource shape
 * (row_counts nested object).
 */
function importRowToApi(row: ImportRow): ImportResource {
  return {
    id: row.id,
    filename: row.filename,
    status: row.status,
    created_at: row.created_at,
    completed_at: row.completed_at,
    error_message: row.error_message,
    row_counts: {
      total: row.total_rows,
      imported: row.imported_rows,
      rejected: row.rejected_rows,
    },
  };
}

/**
 * Parse a positive integer query parameter with a default and hard cap.
 * Returns the default if the value is missing or not a finite positive int.
 */
function parseLimit(
  raw: unknown,
  defaultValue: number,
  maxValue: number,
): number {
  if (typeof raw !== 'string') return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.min(parsed, maxValue);
}

/**
 * Parse a cursor query parameter. Cursors are the primary-key id of the last
 * item returned by the previous page. Returns null for missing/invalid values
 * (which means "start from the beginning").
 */
function parseCursor(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * Quote a CSV field if it contains a comma, quote, newline, or carriage
 * return. Internal double quotes are doubled per RFC 4180.
 */
function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    const escaped = value.replace(/"/g, '""');
    return `"${escaped}"`;
  }
  return value;
}

/**
 * Builds a fresh Express app instance with routes registered.
 *
 * The db is injected so tests can pass an in-memory database and the
 * production server can pass a file-backed one.
 */
export function createApp(db: Database.Database): Express {
  const app = express();
  app.use(express.json());

  const upload = multer({
    storage: multer.memoryStorage(),
    // Hard cap on upload size. For a millions-of-rows production version
    // this would be higher AND the parser would stream instead of buffering.
    limits: { fileSize: 200 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const mimeOk = ALLOWED_CSV_MIME_TYPES.has(file.mimetype);
      const nameOk = /\.csv$/i.test(file.originalname);
      if (mimeOk || nameOk) {
        cb(null, true);
        return;
      }
      cb(
        new Error(
          `${UNSUPPORTED_MEDIA_TYPE_MARKER} expected a CSV file (got mimetype="${file.mimetype}")`,
        ),
      );
    },
  });

  /**
   * Wraps `upload.single('file')` so multer errors surface through the
   * standard error envelope instead of Express's default HTML 500.
   *   - LIMIT_FILE_SIZE    → 413 PAYLOAD_TOO_LARGE
   *   - MIME rejection     → 415 UNSUPPORTED_MEDIA_TYPE
   *   - anything else      → 500 INTERNAL_ERROR
   */
  const uploadSingleFile = (
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    upload.single('file')(req, res, (err: unknown) => {
      if (!err) {
        next();
        return;
      }
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          sendError(
            res,
            413,
            'PAYLOAD_TOO_LARGE',
            'Uploaded file exceeds the maximum allowed size',
          );
          return;
        }
        sendError(res, 400, 'VALIDATION_FAILED', err.message);
        return;
      }
      if (err instanceof Error) {
        if (err.message.startsWith(UNSUPPORTED_MEDIA_TYPE_MARKER)) {
          sendError(
            res,
            415,
            'UNSUPPORTED_MEDIA_TYPE',
            err.message.slice(UNSUPPORTED_MEDIA_TYPE_MARKER.length).trim(),
          );
          return;
        }
        sendError(res, 500, 'INTERNAL_ERROR', err.message);
        return;
      }
      sendError(res, 500, 'INTERNAL_ERROR', 'Unknown upload error');
    });
  };

  // ---- Health -------------------------------------------------------------

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // ---- POST /api/imports --------------------------------------------------
  //
  // Async processing with SHA-256 idempotency:
  //   1. Validate headers synchronously (fast-fail bad CSVs with 400)
  //   2. Compute SHA-256 of the file content
  //   3. Check for an existing import with that hash
  //      - If it exists (and isn't 'failed'), return its current state with
  //        200 and an Idempotent-Replayed: true header
  //      - If 'failed', delete it so we can retry with a fresh row
  //   4. Insert a new imports row with status='processing' and return 202
  //      with a Location: /api/imports/:id header
  //   5. Schedule processImport via setImmediate so the work runs AFTER the
  //      HTTP response is sent. The client polls GET /api/imports/:id.

  app.post('/api/imports', uploadSingleFile, (req: Request, res: Response) => {
    const file = req.file;
    if (!file) {
      sendError(
        res,
        400,
        'VALIDATION_FAILED',
        'No file uploaded (expected field "file")',
      );
      return;
    }

    try {
      // Sync: fast-fail on obvious structural errors before touching the DB.
      validateCsvHeaders(file.buffer);

      // Sync: compute hash and create (or reuse) the import row.
      const fileHash = computeFileHash(file.buffer);
      const { importId, isDuplicate } = createImportRow(
        db,
        file.originalname,
        fileHash,
      );

      const row = db
        .prepare(`SELECT ${IMPORT_SELECT_COLUMNS} FROM imports WHERE id = ?`)
        .get(importId) as ImportRow;

      const body = importRowToApi(row);

      if (isDuplicate) {
        // Idempotent replay: same file already uploaded. Signal this out-
        // of-band via a response header so the response body stays a clean
        // ImportResource that matches every other imports endpoint.
        res.setHeader('Idempotent-Replayed', 'true');
        res.status(200).json(body);
        return;
      }

      // Schedule the actual processing. Capturing file.buffer in the closure
      // is important — by the time setImmediate fires, req may already be
      // gone, so we hoist the buffer into a local variable.
      const buffer = file.buffer;
      setImmediate(() => {
        try {
          processImport(db, importId, buffer);
        } catch {
          // processImport already updates the imports row to 'failed' with
          // the error message. Swallowing here prevents an uncaught
          // exception from crashing the Node process.
        }
      });

      // 202 Accepted: the request is well-formed and accepted for processing,
      // but processing isn't done yet. Location points at the poll URL.
      res.setHeader('Location', `/api/imports/${importId}`);
      res.status(202).json(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 400, 'VALIDATION_FAILED', message);
    }
  });

  // ---- GET /api/imports ---------------------------------------------------
  //
  // Cursor-paginated list of imports, newest first. Because imports.id is a
  // TEXT column (imp_<uuid>), we cannot use it as a monotonic cursor — so we
  // page by SQLite's rowid instead, which IS monotonic and strictly aligned
  // with insertion order. The rowid is returned as _cursor and stripped from
  // the API response shape.

  app.get('/api/imports', (req, res) => {
    const limit = parseLimit(req.query.limit, 100, 500);
    const cursor = parseCursor(req.query.cursor);

    const sql = `
      SELECT rowid AS _cursor, ${IMPORT_SELECT_COLUMNS}
      FROM imports
      ${cursor !== null ? 'WHERE rowid < ?' : ''}
      ORDER BY rowid DESC
      LIMIT ?
    `;
    const params: number[] = [];
    if (cursor !== null) params.push(cursor);
    params.push(limit + 1);

    const rows = db.prepare(sql).all(...params) as ImportRowWithCursor[];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items: ImportResource[] = pageRows.map(importRowToApi);
    const nextCursor =
      hasMore && pageRows.length > 0 ? pageRows.at(-1)!._cursor : null;

    const body: ImportListResponse = {
      items,
      next_cursor: nextCursor,
      has_more: hasMore,
    };
    res.json(body);
  });

  // ---- GET /api/imports/:id -----------------------------------------------
  //
  // Poll endpoint. Client calls this after POST /api/imports returns 202,
  // repeatedly, until status is 'completed' or 'failed'.

  app.get('/api/imports/:id', (req, res) => {
    const row = db
      .prepare(`SELECT ${IMPORT_SELECT_COLUMNS} FROM imports WHERE id = ?`)
      .get(req.params.id) as ImportRow | undefined;

    if (!row) {
      sendError(res, 404, 'NOT_FOUND', 'Import not found');
      return;
    }

    res.json(importRowToApi(row));
  });

  // ---- GET /api/imports/:id/summary ---------------------------------------

  app.get('/api/imports/:id/summary', (req, res) => {
    const importId = req.params.id;

    const importRow = db
      .prepare(`SELECT ${IMPORT_SELECT_COLUMNS} FROM imports WHERE id = ?`)
      .get(importId) as ImportRow | undefined;

    if (!importRow) {
      sendError(res, 404, 'NOT_FOUND', 'Import not found');
      return;
    }

    const byCategoryRows = db
      .prepare(
        `SELECT category, COUNT(*) AS n
         FROM rejection_issues i
         JOIN rejected_rows r ON r.id = i.rejected_row_id
         WHERE r.import_id = ?
         GROUP BY category`,
      )
      .all(importId) as ByCategoryRow[];

    const byCategory: Record<ValidationCategory, number> = {
      structural: 0,
      referential: 0,
      business: 0,
    };
    for (const row of byCategoryRows) {
      byCategory[row.category] = row.n;
    }

    const byCodeRows = db
      .prepare(
        `SELECT i.code, i.category, COUNT(*) AS n, MAX(i.message) AS message
         FROM rejection_issues i
         JOIN rejected_rows r ON r.id = i.rejected_row_id
         WHERE r.import_id = ?
         GROUP BY i.code, i.category
         ORDER BY n DESC`,
      )
      .all(importId) as ByCodeRow[];

    const byCode = byCodeRows.map((row) => ({
      code: row.code,
      category: row.category,
      count: row.n,
      message: row.message,
    }));

    const response: SummaryResponse = {
      import_id: importRow.id,
      filename: importRow.filename,
      status: importRow.status,
      row_counts: {
        total: importRow.total_rows,
        imported: importRow.imported_rows,
        rejected: importRow.rejected_rows,
      },
      issue_counts: {
        by_category: byCategory,
        by_code: byCode,
      },
      links: {
        transactions: `/api/imports/${importRow.id}/transactions`,
        rejected: `/api/imports/${importRow.id}/rejected`,
        rejected_csv: `/api/imports/${importRow.id}/rejected.csv`,
      },
    };

    res.json(response);
  });

  // ---- GET /api/imports/:id/transactions ----------------------------------
  //
  // Cursor-paginated. `cursor` is the id of the last transaction seen by the
  // client; we return rows with id > cursor. Fetch limit+1 rows from SQLite
  // so we can detect has_more without a separate COUNT query.

  app.get('/api/imports/:id/transactions', (req, res) => {
    const importId = req.params.id;

    const exists = db
      .prepare('SELECT 1 AS ok FROM imports WHERE id = ?')
      .get(importId) as { ok: number } | undefined;
    if (!exists) {
      sendError(res, 404, 'NOT_FOUND', 'Import not found');
      return;
    }

    const limit = parseLimit(req.query.limit, 100, 500);
    const cursor = parseCursor(req.query.cursor);
    const reference =
      typeof req.query.reference === 'string' ? req.query.reference : null;
    const accountCode =
      typeof req.query.account_code === 'string'
        ? req.query.account_code
        : null;

    const clauses: string[] = ['import_id = ?'];
    const params: (string | number)[] = [importId];
    if (cursor !== null) {
      clauses.push('id > ?');
      params.push(cursor);
    }
    if (reference !== null) {
      clauses.push('reference = ?');
      params.push(reference);
    }
    if (accountCode !== null) {
      clauses.push('account_code = ?');
      params.push(accountCode);
    }

    const whereSql = clauses.join(' AND ');
    const sql = `
      SELECT id, row_number, reference, txn_date, account_code,
             debit_cents, credit_cents, description, memo
      FROM transactions
      WHERE ${whereSql}
      ORDER BY id ASC
      LIMIT ?
    `;
    params.push(limit + 1);

    const rows = db.prepare(sql).all(...params) as TransactionRow[];
    const hasMore = rows.length > limit;
    const pagedRows = hasMore ? rows.slice(0, limit) : rows;
    const items: Transaction[] = pagedRows.map((row) => ({
      id: row.id,
      import_id: importId,
      row_number: row.row_number,
      reference: row.reference,
      txn_date: row.txn_date,
      account_code: row.account_code,
      debit_cents: row.debit_cents,
      credit_cents: row.credit_cents,
      description: row.description,
      memo: row.memo,
    }));
    const nextCursor =
      hasMore && items.length > 0 ? (items.at(-1)!.id ?? null) : null;

    const body: TransactionListResponse = {
      items,
      next_cursor: nextCursor,
      has_more: hasMore,
    };
    res.json(body);
  });

  // ---- GET /api/imports/:id/rejected --------------------------------------

  app.get('/api/imports/:id/rejected', (req, res) => {
    const importId = req.params.id;

    const exists = db
      .prepare('SELECT 1 AS ok FROM imports WHERE id = ?')
      .get(importId) as { ok: number } | undefined;
    if (!exists) {
      sendError(res, 404, 'NOT_FOUND', 'Import not found');
      return;
    }

    const limit = parseLimit(req.query.limit, 100, 500);
    const cursor = parseCursor(req.query.cursor);
    const rawCategory =
      typeof req.query.category === 'string' ? req.query.category : null;
    const code = typeof req.query.code === 'string' ? req.query.code : null;

    // Validate ?category against the known enum so callers fail loud instead
    // of silently getting an empty list for a typo.
    let category: ValidationCategory | null = null;
    if (rawCategory !== null) {
      if (!VALID_CATEGORIES.includes(rawCategory as ValidationCategory)) {
        const allowed = VALID_CATEGORIES.join(', ');
        sendError(
          res,
          400,
          'VALIDATION_FAILED',
          `Invalid category "${rawCategory}" (allowed: ${allowed})`,
        );
        return;
      }
      category = rawCategory as ValidationCategory;
    }

    const clauses: string[] = ['r.import_id = ?'];
    const params: (string | number)[] = [importId];
    if (cursor !== null) {
      clauses.push('r.id > ?');
      params.push(cursor);
    }

    let sql: string;
    if (category !== null || code !== null) {
      if (category !== null) {
        clauses.push('i.category = ?');
        params.push(category);
      }
      if (code !== null) {
        clauses.push('i.code = ?');
        params.push(code);
      }
      sql = `
        SELECT DISTINCT r.id, r.row_number, r.raw_row
        FROM rejected_rows r
        JOIN rejection_issues i ON i.rejected_row_id = r.id
        WHERE ${clauses.join(' AND ')}
        ORDER BY r.id ASC
        LIMIT ?
      `;
    } else {
      sql = `
        SELECT r.id, r.row_number, r.raw_row
        FROM rejected_rows r
        WHERE ${clauses.join(' AND ')}
        ORDER BY r.id ASC
        LIMIT ?
      `;
    }
    params.push(limit + 1);

    const rejectedRows = db.prepare(sql).all(...params) as RejectedRowDbRow[];
    const hasMore = rejectedRows.length > limit;
    const pagedRows = hasMore ? rejectedRows.slice(0, limit) : rejectedRows;
    const nextCursor =
      hasMore && pagedRows.length > 0 ? (pagedRows.at(-1)!.id ?? null) : null;

    // For each rejected row, fetch its issues. N+1 is bounded by `limit`.
    const issueStmt = db.prepare(
      `SELECT category, code, field, message, context_json
       FROM rejection_issues
       WHERE rejected_row_id = ?
       ORDER BY id ASC`,
    );

    const items: RejectedRow[] = pagedRows.map((row) => {
      const issueRows = issueStmt.all(row.id) as RejectionIssueRow[];
      const issues: RejectionIssue[] = issueRows.map((issue) => {
        const parsedContext =
          issue.context_json !== null
            ? (JSON.parse(issue.context_json) as Record<string, unknown>)
            : undefined;
        const base: RejectionIssue = {
          category: issue.category,
          code: issue.code,
          field: issue.field,
          message: issue.message,
        };
        if (parsedContext !== undefined) {
          base.context = parsedContext;
        }
        return base;
      });
      return {
        id: row.id,
        import_id: importId,
        row_number: row.row_number,
        raw_row: row.raw_row,
        issues,
      };
    });

    const body: RejectedListResponse = {
      items,
      next_cursor: nextCursor,
      has_more: hasMore,
    };
    res.json(body);
  });

  // ---- GET /api/imports/:id/rejected.csv ----------------------------------

  app.get('/api/imports/:id/rejected.csv', (req, res) => {
    const importId = req.params.id;

    const exists = db
      .prepare('SELECT 1 AS ok FROM imports WHERE id = ?')
      .get(importId) as { ok: number } | undefined;
    if (!exists) {
      sendError(res, 404, 'NOT_FOUND', 'Import not found');
      return;
    }

    const rejectedRows = db
      .prepare(
        `SELECT id, row_number, raw_row
         FROM rejected_rows
         WHERE import_id = ?
         ORDER BY id ASC`,
      )
      .all(importId) as RejectedRowDbRow[];

    const issueStmt = db.prepare(
      `SELECT code, message
       FROM rejection_issues
       WHERE rejected_row_id = ?
       ORDER BY id ASC`,
    );

    const header = 'row_number,raw_row,error_codes,error_messages';
    const lines: string[] = [header];

    for (const row of rejectedRows) {
      const issues = issueStmt.all(row.id) as Array<{
        code: string;
        message: string;
      }>;
      const codes = issues.map((i) => i.code).join('; ');
      const messages = issues.map((i) => i.message).join('; ');
      lines.push(
        [
          String(row.row_number),
          csvEscape(row.raw_row),
          csvEscape(codes),
          csvEscape(messages),
        ].join(','),
      );
    }

    const body = lines.join('\n');
    const filename = `rejected-${importId}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(body);
  });

  return app;
}
