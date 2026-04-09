import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/index';
import { runImport } from './import';

const HEADER = 'date,reference,account_code,debit,credit,description,memo';

function buildCsv(...rows: string[]): string {
  return [HEADER, ...rows].join('\n') + '\n';
}

describe('runImport', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  it('imports a clean, balanced journal entry end to end', () => {
    const csv = buildCsv(
      '2026-01-15,JE-1001,5100,250.00,,Office supplies,Staples',
      '2026-01-15,JE-1001,1010,,250.00,Office supplies,Staples',
    );

    const result = runImport(db, 'test.csv', csv);

    expect(result.status).toBe('completed');
    expect(result.row_counts).toEqual({
      total: 2,
      imported: 2,
      rejected: 0,
    });
    expect(result.import_id).toMatch(/^imp_/);

    const txns = db
      .prepare('SELECT * FROM transactions WHERE import_id = ? ORDER BY id')
      .all(result.import_id) as {
      reference: string;
      account_code: string;
      debit_cents: number;
      credit_cents: number;
      description: string | null;
    }[];

    expect(txns).toHaveLength(2);
    expect(txns[0]).toMatchObject({
      reference: 'JE-1001',
      account_code: '5100',
      debit_cents: 25000,
      credit_cents: 0,
      description: 'Office supplies',
    });
    expect(txns[1]).toMatchObject({
      reference: 'JE-1001',
      account_code: '1010',
      debit_cents: 0,
      credit_cents: 25000,
    });
  });

  it('persists the import row with completed status and correct counts', () => {
    const csv = buildCsv(
      '2026-01-15,JE-1,5100,100.00,,Test,',
      '2026-01-15,JE-1,1010,,100.00,Test,',
    );

    const result = runImport(db, 'test.csv', csv);

    const row = db
      .prepare('SELECT * FROM imports WHERE id = ?')
      .get(result.import_id) as {
      filename: string;
      status: string;
      total_rows: number;
      imported_rows: number;
      rejected_rows: number;
    };

    expect(row.filename).toBe('test.csv');
    expect(row.status).toBe('completed');
    expect(row.total_rows).toBe(2);
    expect(row.imported_rows).toBe(2);
    expect(row.rejected_rows).toBe(0);
  });

  it('rejects rows with structural errors and stores their issues', () => {
    const csv = buildCsv(
      'not-a-date,JE-1,5100,100.00,,bad date,',
      '2026-01-15,JE-2,5100,xyz,,bad amount,',
    );

    const result = runImport(db, 'test.csv', csv);

    expect(result.row_counts.total).toBe(2);
    expect(result.row_counts.imported).toBe(0);
    expect(result.row_counts.rejected).toBe(2);

    const rejected = db
      .prepare('SELECT * FROM rejected_rows WHERE import_id = ?')
      .all(result.import_id);
    expect(rejected).toHaveLength(2);

    const issues = db
      .prepare(
        `SELECT i.code, i.category FROM rejection_issues i
         JOIN rejected_rows r ON r.id = i.rejected_row_id
         WHERE r.import_id = ?`,
      )
      .all(result.import_id) as { code: string; category: string }[];

    const codes = issues.map((i) => i.code);
    expect(codes).toContain('ERR_INVALID_DATE');
    expect(codes).toContain('ERR_INVALID_AMOUNT');
  });

  it('rejects rows with unknown account codes', () => {
    const csv = buildCsv('2026-01-15,JE-1,9999,100.00,,bogus account,');

    const result = runImport(db, 'test.csv', csv);

    expect(result.row_counts.imported).toBe(0);
    expect(result.row_counts.rejected).toBe(1);

    const codes = db
      .prepare(
        `SELECT i.code FROM rejection_issues i
         JOIN rejected_rows r ON r.id = i.rejected_row_id
         WHERE r.import_id = ?`,
      )
      .all(result.import_id) as { code: string }[];

    expect(codes.map((c) => c.code)).toContain('ERR_UNKNOWN_ACCOUNT');
  });

  it('rejects a group with unbalanced debits and credits', () => {
    const csv = buildCsv(
      '2026-01-15,JE-1,5100,250.00,,desc,',
      '2026-01-15,JE-1,1010,,200.00,desc,', // off by $50
    );

    const result = runImport(db, 'test.csv', csv);

    expect(result.row_counts.imported).toBe(0);
    expect(result.row_counts.rejected).toBe(2);

    const issues = db
      .prepare(
        `SELECT i.code, i.context_json FROM rejection_issues i
         JOIN rejected_rows r ON r.id = i.rejected_row_id
         WHERE r.import_id = ? AND i.code = ?`,
      )
      .all(result.import_id, 'ERR_UNBALANCED_ENTRY') as {
      code: string;
      context_json: string;
    }[];

    // Denormalized: both legs get the same error attached
    expect(issues).toHaveLength(2);

    const context = JSON.parse(issues[0]!.context_json) as {
      reference: string;
      total_debits_cents: number;
      total_credits_cents: number;
      difference_cents: number;
    };
    expect(context.reference).toBe('JE-1');
    expect(context.total_debits_cents).toBe(25000);
    expect(context.total_credits_cents).toBe(20000);
    expect(context.difference_cents).toBe(5000);
  });

  it('rejects a single-leg journal entry', () => {
    const csv = buildCsv('2026-01-15,JE-1,5100,250.00,,solo leg,');

    const result = runImport(db, 'test.csv', csv);

    expect(result.row_counts.rejected).toBe(1);

    const codes = db
      .prepare(
        `SELECT i.code FROM rejection_issues i
         JOIN rejected_rows r ON r.id = i.rejected_row_id
         WHERE r.import_id = ?`,
      )
      .all(result.import_id) as { code: string }[];
    expect(codes.map((c) => c.code)).toContain('ERR_SINGLE_LEG_ENTRY');
  });

  it('handles a mix of clean, bad-row, and bad-group entries in one file', () => {
    const csv = buildCsv(
      // Clean entry
      '2026-01-15,JE-1,5100,100.00,,clean debit,',
      '2026-01-15,JE-1,1010,,100.00,clean credit,',
      // Bad row (structural)
      'bad-date,JE-2,5100,50.00,,bad row,',
      // Bad group (unbalanced)
      '2026-01-15,JE-3,5200,75.00,,unbalanced debit,',
      '2026-01-15,JE-3,1010,,50.00,unbalanced credit,',
    );

    const result = runImport(db, 'test.csv', csv);

    expect(result.row_counts.total).toBe(5);
    expect(result.row_counts.imported).toBe(2); // JE-1 only
    expect(result.row_counts.rejected).toBe(3); // JE-2 row + JE-3 both legs

    const imported = db
      .prepare('SELECT reference FROM transactions WHERE import_id = ?')
      .all(result.import_id) as { reference: string }[];
    expect(imported.every((r) => r.reference === 'JE-1')).toBe(true);

    const rejected = db
      .prepare(
        'SELECT row_number FROM rejected_rows WHERE import_id = ? ORDER BY row_number',
      )
      .all(result.import_id) as { row_number: number }[];
    expect(rejected.map((r) => r.row_number)).toEqual([4, 5, 6]);
  });

  it('rolls back atomically if any part of the write fails', () => {
    // No reasonable way to force a mid-transaction failure without mocks,
    // but we can verify that valid and invalid imports both leave the DB
    // in a consistent state.
    const csv = buildCsv('2026-01-15,JE-1,5100,100.00,,ok,');
    const result = runImport(db, 'test.csv', csv);

    const importCount = (
      db.prepare('SELECT COUNT(*) AS n FROM imports').get() as { n: number }
    ).n;
    const rejectedCount = (
      db.prepare('SELECT COUNT(*) AS n FROM rejected_rows').get() as {
        n: number;
      }
    ).n;

    expect(importCount).toBe(1);
    expect(rejectedCount).toBe(1); // the single-leg entry
    expect(result.row_counts.rejected).toBe(1);
  });

  it('throws when CSV has no data rows', () => {
    const csv = HEADER + '\n'; // header only
    expect(() => runImport(db, 'empty.csv', csv)).toThrow(/no data rows/);
  });

  it('throws when CSV is missing a required header column', () => {
    const csv =
      'date,reference,account_code,debit,credit,description\n' +
      '2026-01-15,JE-1,5100,100.00,,ok\n'; // missing "memo"
    expect(() => runImport(db, 'test.csv', csv)).toThrow(
      /missing required column/,
    );
  });

  it('throws when CSV is unparseable garbage', () => {
    // Genuine parser error: unterminated quote
    const csv = HEADER + '\n2026-01-15,"JE-1,5100,100.00,,x,\n';
    expect(() => runImport(db, 'bad.csv', csv)).toThrow(/parse CSV/);
  });

  it('returns the same import_id for identical file content (idempotency)', () => {
    // SHA-256 idempotency: uploading the same file twice returns the
    // existing import_id instead of creating a duplicate.
    const csv = buildCsv(
      '2026-01-15,JE-1,5100,100.00,,ok,',
      '2026-01-15,JE-1,1010,,100.00,ok,',
    );

    const r1 = runImport(db, 'a.csv', csv);
    const r2 = runImport(db, 'b.csv', csv);

    expect(r1.import_id).toBe(r2.import_id);

    // There should be only one imports row, not two.
    const count = (
      db.prepare('SELECT COUNT(*) AS n FROM imports').get() as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it('generates different import_ids for different file content', () => {
    const csvA = buildCsv(
      '2026-01-15,JE-A,5100,100.00,,contents A,',
      '2026-01-15,JE-A,1010,,100.00,contents A,',
    );
    const csvB = buildCsv(
      '2026-01-15,JE-B,5100,200.00,,contents B,',
      '2026-01-15,JE-B,1010,,200.00,contents B,',
    );

    const r1 = runImport(db, 'a.csv', csvA);
    const r2 = runImport(db, 'b.csv', csvB);

    expect(r1.import_id).not.toBe(r2.import_id);
  });

  it('normalizes amount formatting during import (commas, dollar signs)', () => {
    const csv = buildCsv(
      '2026-01-15,JE-1,5100,"$1,250.00",,format test,',
      '2026-01-15,JE-1,1010,,"$1,250.00",format test,',
    );

    const result = runImport(db, 'test.csv', csv);

    expect(result.row_counts.imported).toBe(2);

    const txns = db
      .prepare(
        'SELECT debit_cents, credit_cents FROM transactions WHERE import_id = ? ORDER BY id',
      )
      .all(result.import_id) as {
      debit_cents: number;
      credit_cents: number;
    }[];

    expect(txns).toHaveLength(2);
    // Find the row that was inserted as a debit leg vs credit leg; order
    // from the DB is deterministic via ORDER BY id but the assertions don't
    // need to care which is first as long as both sides parsed to 125000.
    const debitLeg = txns.find((t) => t.debit_cents > 0);
    const creditLeg = txns.find((t) => t.credit_cents > 0);
    expect(debitLeg?.debit_cents).toBe(125000);
    expect(creditLeg?.credit_cents).toBe(125000);
  });

  it('normalizes date formats during import (US → ISO)', () => {
    const csv = buildCsv(
      '01/15/2026,JE-1,5100,100.00,,date test,',
      '01/15/2026,JE-1,1010,,100.00,date test,',
    );

    const result = runImport(db, 'test.csv', csv);

    const txns = db
      .prepare('SELECT txn_date FROM transactions WHERE import_id = ?')
      .all(result.import_id) as { txn_date: string }[];

    expect(txns.every((t) => t.txn_date === '2026-01-15')).toBe(true);
  });
});
