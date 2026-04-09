import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createDatabase } from './index';

/**
 * Generate a unique tempfile path for a file-backed SQLite test and return
 * a cleanup function that removes the main file plus the WAL sidecars.
 */
function tempDbPath(label: string): {
  path: string;
  cleanup: () => void;
} {
  const path = join(
    tmpdir(),
    `ledger-test-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
  );
  const cleanup = () => {
    for (const ext of ['', '-wal', '-shm']) {
      try {
        rmSync(path + ext, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
  };
  return { path, cleanup };
}

describe('createDatabase', () => {
  it('creates an in-memory database with every expected table', () => {
    const db = createDatabase(':memory:');

    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as { name: string }[];

    const names = rows.map((r) => r.name);
    expect(names).toContain('accounts');
    expect(names).toContain('imports');
    expect(names).toContain('transactions');
    expect(names).toContain('rejected_rows');
    expect(names).toContain('rejection_issues');

    db.close();
  });

  it('seeds the chart of accounts from the JSON file', () => {
    const db = createDatabase(':memory:');

    const { n } = db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as {
      n: number;
    };
    expect(n).toBeGreaterThanOrEqual(15);

    const cash = db
      .prepare('SELECT * FROM accounts WHERE code = ?')
      .get('1010') as
      | {
          code: string;
          name: string;
          type: string;
          normal_balance: string;
        }
      | undefined;

    expect(cash).toBeDefined();
    expect(cash?.name).toBe('Cash');
    expect(cash?.type).toBe('asset');
    expect(cash?.normal_balance).toBe('debit');

    db.close();
  });

  it('seeds accounts covering every account type', () => {
    const db = createDatabase(':memory:');

    const rows = db
      .prepare('SELECT DISTINCT type FROM accounts ORDER BY type')
      .all() as { type: string }[];

    const types = rows.map((r) => r.type);
    expect(types).toEqual([
      'asset',
      'equity',
      'expense',
      'liability',
      'revenue',
    ]);

    db.close();
  });

  it('enables foreign key enforcement on the connection', () => {
    const db = createDatabase(':memory:');

    const { foreign_keys } = db.prepare('PRAGMA foreign_keys').get() as {
      foreign_keys: number;
    };
    expect(foreign_keys).toBe(1);

    db.close();
  });

  it('rejects transactions that reference an unknown account code', () => {
    const db = createDatabase(':memory:');

    db.prepare(
      `INSERT INTO imports (id, filename, status, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run('imp_test', 'test.csv', 'completed', '2026-04-09T00:00:00Z');

    const insertTxn = db.prepare(
      `INSERT INTO transactions
         (import_id, row_number, reference, txn_date,
          account_code, debit_cents, credit_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    // Valid account — should succeed.
    expect(() =>
      insertTxn.run('imp_test', 1, 'JE-1', '2026-04-09', '1010', 10000, 0),
    ).not.toThrow();

    // Unknown account — should fail the FK check.
    expect(() =>
      insertTxn.run('imp_test', 2, 'JE-1', '2026-04-09', 'BOGUS', 0, 10000),
    ).toThrow(/FOREIGN KEY/);

    db.close();
  });

  it('migrates a legacy database that lacks the file_hash column', () => {
    // Simulate an old database created before file_hash was added. We create
    // a bare imports table manually (no file_hash) then call createDatabase on
    // the same path and verify the migration added the column without losing
    // the pre-existing row.
    const { path, cleanup } = tempDbPath('migrate');
    try {
      const oldDb = new Database(path);
      oldDb.pragma('foreign_keys = ON');
      oldDb
        .prepare(
          `CREATE TABLE imports (
             id TEXT PRIMARY KEY,
             filename TEXT NOT NULL,
             status TEXT NOT NULL,
             total_rows INTEGER NOT NULL DEFAULT 0,
             imported_rows INTEGER NOT NULL DEFAULT 0,
             rejected_rows INTEGER NOT NULL DEFAULT 0,
             created_at TEXT NOT NULL,
             completed_at TEXT,
             error_message TEXT
           )`,
        )
        .run();
      oldDb
        .prepare(
          `INSERT INTO imports (id, filename, status, created_at)
           VALUES ('imp_legacy', 'legacy.csv', 'completed', '2026-01-01T00:00:00Z')`,
        )
        .run();

      // Sanity: the legacy DB really has no file_hash column.
      const before = oldDb
        .prepare('PRAGMA table_info(imports)')
        .all() as Array<{ name: string }>;
      expect(before.some((c) => c.name === 'file_hash')).toBe(false);
      oldDb.close();

      // Open via createDatabase — this should trigger the migration.
      const migratedDb = createDatabase(path);
      const after = migratedDb
        .prepare('PRAGMA table_info(imports)')
        .all() as Array<{ name: string }>;
      expect(after.some((c) => c.name === 'file_hash')).toBe(true);

      // Pre-existing row should be preserved (with NULL file_hash).
      const legacy = migratedDb
        .prepare('SELECT id, filename, file_hash FROM imports WHERE id = ?')
        .get('imp_legacy') as
        | { id: string; filename: string; file_hash: string | null }
        | undefined;
      expect(legacy).toBeDefined();
      expect(legacy?.filename).toBe('legacy.csv');
      expect(legacy?.file_hash).toBeNull();

      // A new insert with a non-null file_hash should also work.
      expect(() =>
        migratedDb
          .prepare(
            `INSERT INTO imports (id, filename, file_hash, status, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            'imp_fresh',
            'fresh.csv',
            'abc123',
            'completed',
            '2026-02-01T00:00:00Z',
          ),
      ).not.toThrow();

      migratedDb.close();
    } finally {
      cleanup();
    }
  });

  it('persists data across reopens of a file-backed database', () => {
    // End-to-end smoke test for file persistence: insert into one connection,
    // close, reopen, and verify the data is still there. This is the core
    // guarantee the `LEDGER_DB=./ledger.db` dev mode relies on.
    const { path, cleanup } = tempDbPath('persist');
    try {
      const first = createDatabase(path);
      first
        .prepare(
          `INSERT INTO imports
             (id, filename, file_hash, status, total_rows,
              imported_rows, rejected_rows, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'imp_persist',
          'persist.csv',
          'hash_persist',
          'completed',
          10,
          8,
          2,
          '2026-03-01T00:00:00Z',
        );
      first.close();

      const second = createDatabase(path);
      const row = second
        .prepare(
          `SELECT id, filename, file_hash, status, total_rows
           FROM imports WHERE id = ?`,
        )
        .get('imp_persist') as
        | {
            id: string;
            filename: string;
            file_hash: string;
            status: string;
            total_rows: number;
          }
        | undefined;

      expect(row).toBeDefined();
      expect(row?.filename).toBe('persist.csv');
      expect(row?.file_hash).toBe('hash_persist');
      expect(row?.total_rows).toBe(10);

      // Chart of accounts must be re-seedable without duplicates (idempotent).
      const accountCount = (
        second.prepare('SELECT COUNT(*) AS n FROM accounts').get() as {
          n: number;
        }
      ).n;
      expect(accountCount).toBeGreaterThanOrEqual(15);
      second.close();
    } finally {
      cleanup();
    }
  });

  it('cascades delete from imports to transactions and rejected_rows', () => {
    const db = createDatabase(':memory:');

    db.prepare(
      `INSERT INTO imports (id, filename, status, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run('imp_cascade', 'test.csv', 'completed', '2026-04-09T00:00:00Z');

    db.prepare(
      `INSERT INTO transactions
         (import_id, row_number, reference, txn_date,
          account_code, debit_cents, credit_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('imp_cascade', 1, 'JE-1', '2026-04-09', '1010', 10000, 0);

    db.prepare(
      `INSERT INTO rejected_rows (import_id, row_number, raw_row)
       VALUES (?, ?, ?)`,
    ).run('imp_cascade', 2, 'bad,row,here');

    db.prepare('DELETE FROM imports WHERE id = ?').run('imp_cascade');

    const txnCount = (
      db
        .prepare('SELECT COUNT(*) AS n FROM transactions WHERE import_id = ?')
        .get('imp_cascade') as { n: number }
    ).n;
    const rejCount = (
      db
        .prepare('SELECT COUNT(*) AS n FROM rejected_rows WHERE import_id = ?')
        .get('imp_cascade') as { n: number }
    ).n;

    expect(txnCount).toBe(0);
    expect(rejCount).toBe(0);

    db.close();
  });
});
