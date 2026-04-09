import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Account } from '../../shared/types';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Initialize a SQLite database for the ledger import tool.
 *
 * @param dbPath Path to the database file, or ':memory:' for an isolated
 *   in-memory database. Tests use ':memory:' to get a fresh DB per case
 *   without any cleanup.
 *
 * The returned database has:
 *  - Foreign key enforcement turned on (must be set per-connection in SQLite)
 *  - WAL journal mode for better concurrent read performance
 *  - Full schema applied (CREATE IF NOT EXISTS makes this idempotent)
 *  - Chart of accounts seeded from data/chart-of-accounts.json
 */
export function createDatabase(dbPath: string = ':memory:'): Database.Database {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');

  // Migrations MUST run before applySchema because schema.sql references
  // columns (like file_hash) that older databases may not have yet. If the
  // index creation in applySchema fired first on an old DB, it would fail
  // before the migration could fix the missing column.
  migrate(db);
  applySchema(db);
  seedChartOfAccounts(db);

  return db;
}

/**
 * Idempotent schema migrations.
 *
 * Each step checks whether the change is needed before applying it, so this
 * function is safe to run on any database — fresh or pre-existing. It's the
 * cheapest possible migration story: no version table, no forward/back,
 * just defensive checks that do nothing on an already-migrated DB.
 *
 * For a production system we'd add a `schema_migrations` table and a proper
 * migration runner. For a 2-hour interview build with a single schema
 * change, this is enough.
 */
function migrate(db: Database.Database): void {
  // If the imports table doesn't exist yet, this is a fresh database and
  // applySchema will create everything with the current schema. No migration
  // needed.
  const tableExists = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'imports'`,
    )
    .get() as { name: string } | undefined;

  if (!tableExists) {
    return;
  }

  // Migration: file_hash column was added to imports for SHA-256 idempotency.
  // Pre-existing databases created before this change won't have the column.
  const columns = db.prepare('PRAGMA table_info(imports)').all() as Array<{
    name: string;
  }>;

  const hasFileHash = columns.some((c) => c.name === 'file_hash');
  if (!hasFileHash) {
    db.prepare('ALTER TABLE imports ADD COLUMN file_hash TEXT').run();
  }
}

/**
 * Read schema.sql and apply each DDL statement individually.
 *
 * We split the file on semicolons rather than using a multi-statement runner
 * because this keeps the call surface narrow (prepare + run) and makes the
 * schema application easy to wrap in a single transaction.
 */
function applySchema(db: Database.Database): void {
  const schemaSql = readFileSync(resolve(here, 'schema.sql'), 'utf8');

  // Strip SQL line comments first so they don't end up as empty statements.
  const cleaned = schemaSql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  const statements = cleaned
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const applyAll = db.transaction(() => {
    for (const stmt of statements) {
      db.prepare(stmt).run();
    }
  });

  applyAll();
}

function seedChartOfAccounts(db: Database.Database): void {
  const chartPath = resolve(here, '../../data/chart-of-accounts.json');
  const chart = JSON.parse(readFileSync(chartPath, 'utf8')) as Account[];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO accounts (code, name, type, normal_balance)
    VALUES (?, ?, ?, ?)
  `);

  const seed = db.transaction((accounts: Account[]) => {
    for (const a of accounts) {
      insert.run(a.code, a.name, a.type, a.normal_balance);
    }
  });

  seed(chart);
}
