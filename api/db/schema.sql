-- Ledger Import — SQLite schema
-- Applied on every database initialization. CREATE IF NOT EXISTS makes this
-- idempotent so it's safe to re-run on an existing database.

-- Chart of accounts (seeded from data/chart-of-accounts.json at init time)
CREATE TABLE IF NOT EXISTS accounts (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense')),
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('debit','credit'))
);

-- Import batches: first-class resource with a lifecycle.
-- file_hash is SHA-256 of the uploaded file content. It's nullable so
-- legacy test fixtures that insert rows directly (without going through
-- the import engine) don't break. Production inserts always populate it.
-- The UNIQUE index on file_hash powers idempotency: re-uploading the same
-- file returns the existing import_id instead of creating a duplicate.
-- SQLite treats multiple NULL values as distinct, so nullable + UNIQUE
-- coexist fine.
CREATE TABLE IF NOT EXISTS imports (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  file_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('processing','completed','failed')),
  total_rows INTEGER NOT NULL DEFAULT 0,
  imported_rows INTEGER NOT NULL DEFAULT 0,
  rejected_rows INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_imports_created ON imports(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_imports_file_hash ON imports(file_hash);

-- The ledger: rows that passed validation and were imported.
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  reference TEXT NOT NULL,
  txn_date TEXT NOT NULL,
  account_code TEXT NOT NULL REFERENCES accounts(code),
  debit_cents INTEGER NOT NULL,
  credit_cents INTEGER NOT NULL,
  description TEXT,
  memo TEXT
);

CREATE INDEX IF NOT EXISTS idx_txns_import ON transactions(import_id, id);
CREATE INDEX IF NOT EXISTS idx_txns_reference ON transactions(import_id, reference);
CREATE INDEX IF NOT EXISTS idx_txns_account ON transactions(import_id, account_code);

-- Audit sidecar: rows that failed validation and were dropped.
CREATE TABLE IF NOT EXISTS rejected_rows (
  id INTEGER PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  raw_row TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rejected_import ON rejected_rows(import_id, id);

-- Issues attached to rejected rows. One row can have multiple issues; group-level
-- issues (unbalanced entry, single leg) are denormalized onto every leg.
CREATE TABLE IF NOT EXISTS rejection_issues (
  id INTEGER PRIMARY KEY,
  rejected_row_id INTEGER NOT NULL REFERENCES rejected_rows(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('structural','referential','business')),
  code TEXT NOT NULL,
  field TEXT,
  message TEXT NOT NULL,
  context_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_issues_row ON rejection_issues(rejected_row_id);
CREATE INDEX IF NOT EXISTS idx_issues_code ON rejection_issues(code);
