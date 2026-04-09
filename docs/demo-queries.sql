-- =============================================================================
-- Demo queries for browsing ledger.db during the interview demo.
--
-- How to use:
--   1. Start the server with `npm run dev:persist` so ledger.db exists on disk
--   2. Upload a CSV via the frontend at http://localhost:5173
--   3. Open DB Browser for SQLite and open ledger.db in read-only mode
--   4. Open this file via File → Open SQL File
--   5. Click the query you want to run and hit F5 (or the blue triangle)
--
-- The subqueries consistently pull the most recent import:
--     WHERE import_id = (SELECT id FROM imports ORDER BY created_at DESC LIMIT 1)
-- so every section gives you the latest upload's view without editing.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Imports: the batch-level view
--
-- Every upload creates one row in `imports`. This is the dashboard summary
-- that powers GET /api/imports on the backend.
-- -----------------------------------------------------------------------------
SELECT
  id,
  filename,
  status,
  total_rows,
  imported_rows,
  rejected_rows,
  datetime(created_at) AS created_at,
  datetime(completed_at) AS completed_at
FROM imports
ORDER BY created_at DESC;


-- -----------------------------------------------------------------------------
-- 2. Imported transactions from the most recent upload
--
-- Joins to `accounts` to pull the human-readable name so you can see
-- "5100 — Office Supplies Expense" instead of just "5100". Capped at 200
-- rows so the grid is navigable.
-- -----------------------------------------------------------------------------
SELECT
  t.row_number     AS row_num,
  t.reference      AS journal_entry,
  t.txn_date       AS date,
  t.account_code   AS account,
  a.name           AS account_name,
  printf('%.2f', t.debit_cents / 100.0)  AS debit,
  printf('%.2f', t.credit_cents / 100.0) AS credit,
  t.description,
  t.memo
FROM transactions t
JOIN accounts a ON a.code = t.account_code
WHERE t.import_id = (SELECT id FROM imports ORDER BY created_at DESC LIMIT 1)
ORDER BY t.id
LIMIT 200;


-- -----------------------------------------------------------------------------
-- 3. Rejected rows with every error attached
--
-- Groups rejection issues back to their source row with GROUP_CONCAT. For
-- the denormalized group errors (ERR_UNBALANCED_ENTRY, ERR_SINGLE_LEG_ENTRY)
-- every leg of the bad journal entry shows up here.
-- -----------------------------------------------------------------------------
SELECT
  r.row_number,
  r.raw_row,
  GROUP_CONCAT(i.code, '; ')    AS error_codes,
  GROUP_CONCAT(i.message, ' | ') AS error_messages
FROM rejected_rows r
JOIN rejection_issues i ON i.rejected_row_id = r.id
WHERE r.import_id = (SELECT id FROM imports ORDER BY created_at DESC LIMIT 1)
GROUP BY r.id
ORDER BY r.row_number
LIMIT 200;


-- -----------------------------------------------------------------------------
-- 4. Error breakdown: which categories and codes are hitting the most
--
-- The same aggregation that powers GET /api/imports/:id/summary.by_code.
-- Useful for a talking point: "80% of rejections are referential — the
-- uploader needs to update their chart of accounts mapping."
-- -----------------------------------------------------------------------------
SELECT
  i.category,
  i.code,
  COUNT(*)         AS count,
  MAX(i.message)   AS sample_message
FROM rejection_issues i
JOIN rejected_rows r ON r.id = i.rejected_row_id
WHERE r.import_id = (SELECT id FROM imports ORDER BY created_at DESC LIMIT 1)
GROUP BY i.category, i.code
ORDER BY count DESC;


-- -----------------------------------------------------------------------------
-- 5. Double-entry integrity check
--
-- Every imported journal entry MUST have debits = credits. If this query
-- ever returns rows, there's a bug in the engine because the group validator
-- should have rejected them before they reached the transactions table.
--
-- Running this during the demo is a great way to prove the invariant holds.
-- -----------------------------------------------------------------------------
SELECT
  reference,
  COUNT(*) AS leg_count,
  printf('%.2f', SUM(debit_cents) / 100.0)  AS total_debits,
  printf('%.2f', SUM(credit_cents) / 100.0) AS total_credits,
  printf('%.2f', (SUM(debit_cents) - SUM(credit_cents)) / 100.0) AS difference
FROM transactions
WHERE import_id = (SELECT id FROM imports ORDER BY created_at DESC LIMIT 1)
GROUP BY reference
HAVING SUM(debit_cents) != SUM(credit_cents);
-- Expected result: 0 rows. If you get any, the engine is broken.


-- -----------------------------------------------------------------------------
-- 6. Trial-balance shape: total debits and credits per account
--
-- This is the "tell me what hit each GL account" view every accountant
-- recognizes. Sorting by absolute net activity puts the most-affected
-- accounts at the top.
-- -----------------------------------------------------------------------------
SELECT
  a.code,
  a.name,
  a.type,
  a.normal_balance,
  printf('%.2f', SUM(t.debit_cents) / 100.0)  AS total_debits,
  printf('%.2f', SUM(t.credit_cents) / 100.0) AS total_credits,
  printf('%.2f', (SUM(t.debit_cents) - SUM(t.credit_cents)) / 100.0) AS net_activity
FROM transactions t
JOIN accounts a ON a.code = t.account_code
WHERE t.import_id = (SELECT id FROM imports ORDER BY created_at DESC LIMIT 1)
GROUP BY a.code, a.name, a.type, a.normal_balance
ORDER BY ABS(SUM(t.debit_cents) - SUM(t.credit_cents)) DESC;


-- -----------------------------------------------------------------------------
-- 7. Show all legs of a specific journal entry
--
-- Replace 'JE-10001' with whatever reference you want to drill into. Useful
-- for showing "see, this single journal entry has three legs that balance
-- to zero".
-- -----------------------------------------------------------------------------
SELECT
  t.row_number,
  t.txn_date,
  t.account_code,
  a.name AS account_name,
  printf('%.2f', t.debit_cents / 100.0)  AS debit,
  printf('%.2f', t.credit_cents / 100.0) AS credit,
  t.description,
  t.memo
FROM transactions t
JOIN accounts a ON a.code = t.account_code
WHERE t.import_id = (SELECT id FROM imports ORDER BY created_at DESC LIMIT 1)
  AND t.reference = 'JE-10001'
ORDER BY t.id;


-- -----------------------------------------------------------------------------
-- 8. Chart of accounts (seeded reference data)
--
-- This table is seeded from data/chart-of-accounts.json at server startup.
-- Never populated by uploads — it's the static reference the referential
-- validator checks every row against.
-- -----------------------------------------------------------------------------
SELECT
  code,
  name,
  type,
  normal_balance
FROM accounts
ORDER BY type, code;


-- -----------------------------------------------------------------------------
-- 9. Idempotency evidence: the file_hash column
--
-- Every import row stores the SHA-256 of the uploaded file. Re-uploading
-- the same file returns the existing import_id instead of duplicating.
-- This query shows the hash so you can prove uniqueness.
-- -----------------------------------------------------------------------------
SELECT
  id,
  filename,
  substr(file_hash, 1, 16) || '...' AS file_hash_prefix,
  status,
  imported_rows,
  rejected_rows
FROM imports
ORDER BY created_at DESC;


-- -----------------------------------------------------------------------------
-- 10. Table sizes (how much data is in the database)
--
-- Good for showing the interviewer "yes, 250K rows actually ended up on
-- disk, not just in memory".
-- -----------------------------------------------------------------------------
SELECT 'imports'          AS table_name, COUNT(*) AS row_count FROM imports
UNION ALL
SELECT 'transactions',        COUNT(*) FROM transactions
UNION ALL
SELECT 'rejected_rows',       COUNT(*) FROM rejected_rows
UNION ALL
SELECT 'rejection_issues',    COUNT(*) FROM rejection_issues
UNION ALL
SELECT 'accounts',            COUNT(*) FROM accounts;
