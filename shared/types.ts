// Shared types imported by both the engine (api/) and the UI (src/).
// Keep this file free of runtime dependencies so it compiles cleanly in both
// the Node (api) and browser (src) tsconfig projects.

export type AccountType =
  | 'asset'
  | 'liability'
  | 'equity'
  | 'revenue'
  | 'expense';

export type NormalBalance = 'debit' | 'credit';

export type ValidationCategory = 'structural' | 'referential' | 'business';

export type ImportStatus = 'processing' | 'completed' | 'failed';

export type Account = {
  code: string;
  name: string;
  type: AccountType;
  normal_balance: NormalBalance;
};

export type RowCounts = {
  total: number;
  imported: number;
  rejected: number;
};

export type ImportBatch = {
  id: string;
  filename: string;
  status: ImportStatus;
  created_at: string;
  completed_at: string | null;
  error_message: string | null;
  row_counts: RowCounts;
};

export type Transaction = {
  id: number;
  import_id: string;
  row_number: number;
  reference: string;
  txn_date: string;
  account_code: string;
  debit_cents: number;
  credit_cents: number;
  description: string | null;
  memo: string | null;
};

export type RejectionIssue = {
  category: ValidationCategory;
  code: string;
  field: string | null;
  message: string;
  context?: Record<string, unknown>;
};

export type RejectedRow = {
  id: number;
  import_id: string;
  row_number: number;
  raw_row: string;
  issues: RejectionIssue[];
};

// The parsed, normalized form of a CSV row before validation decides its fate.
// This is the internal engine representation, never exposed via the API.
export type ParsedRow = {
  row_number: number;
  reference: string;
  txn_date: string; // ISO YYYY-MM-DD after normalization
  account_code: string;
  debit_cents: number;
  credit_cents: number;
  description: string | null;
  memo: string | null;
  raw_row: string;
};

export type SummaryResponse = {
  import_id: string;
  filename: string;
  status: ImportStatus;
  row_counts: RowCounts;
  issue_counts: {
    by_category: Record<ValidationCategory, number>;
    by_code: Array<{
      code: string;
      category: ValidationCategory;
      count: number;
      message: string;
    }>;
  };
  links: {
    transactions: string;
    rejected: string;
    rejected_csv: string;
  };
};

// ---------------------------------------------------------------------------
// HTTP response contract
// ---------------------------------------------------------------------------
// Every non-2xx response from the API uses this envelope. Error `code` is a
// stable machine-readable identifier; `message` is human-facing; `details`
// carries structured context (field errors, row numbers, etc.) when present.

export type ApiErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL_ERROR';

export type ApiErrorBody = {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
};

// The canonical API shape of an imports row. Distinct from the ImportBatch
// alias above (kept for historical reasons) so the frontend and backend can
// both import this exact symbol when typing responses.
export type ImportResource = {
  id: string;
  filename: string;
  status: ImportStatus;
  created_at: string;
  completed_at: string | null;
  error_message: string | null;
  row_counts: RowCounts;
};

// Generic cursor-paginated list. next_cursor is the opaque id of the last
// item on the current page, to be passed as `cursor` on the next request.
// has_more is derived from a LIMIT+1 probe — no COUNT(*) required.
export type PaginatedResponse<T> = {
  items: T[];
  next_cursor: number | null;
  has_more: boolean;
};

export type ImportListResponse = PaginatedResponse<ImportResource>;
export type TransactionListResponse = PaginatedResponse<Transaction>;
export type RejectedListResponse = PaginatedResponse<RejectedRow>;
