import { useState, useCallback, type ChangeEvent } from 'react';
import type {
  ApiErrorBody,
  ImportResource,
  PaginatedResponse,
  RejectedRow,
  SummaryResponse,
  Transaction,
  ValidationCategory,
} from '../shared/types';

const PAGE_SIZE = 100;
const POLL_INTERVAL_MS = 400;
const MAX_POLL_ATTEMPTS = 300;

/**
 * Format integer cents as a two-decimal dollar string. Zero renders as an
 * em dash so debit-only and credit-only rows read cleanly in the table.
 */
function formatCents(cents: number): string {
  if (cents === 0) return '–';
  return (cents / 100).toFixed(2);
}

/**
 * Map a validation category to its CSS class suffix. The design system has
 * matching colors for each category (blue/purple/orange) on both the summary
 * line and the issue-code badges in the rejected table.
 */
function categoryClass(category: ValidationCategory): string {
  return `cat-${category}`;
}

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [processingStatus, setProcessingStatus] = useState<string | null>(null);
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [importId, setImportId] = useState<string | null>(null);

  const [imported, setImported] = useState<Transaction[]>([]);
  const [importedCursor, setImportedCursor] = useState<number | null>(null);
  const [importedHasMore, setImportedHasMore] = useState(false);
  const [loadingMoreImported, setLoadingMoreImported] = useState(false);

  const [rejected, setRejected] = useState<RejectedRow[]>([]);
  const [rejectedCursor, setRejectedCursor] = useState<number | null>(null);
  const [rejectedHasMore, setRejectedHasMore] = useState(false);
  const [loadingMoreRejected, setLoadingMoreRejected] = useState(false);

  const [error, setError] = useState<string | null>(null);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const nextFile = event.target.files?.[0] ?? null;
    setFile(nextFile);
  }

  /**
   * Poll GET /api/imports/:id until status is completed or failed. Updates
   * processingStatus on each poll so the user sees progress.
   */
  async function pollUntilDone(id: string): Promise<ImportResource> {
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      const res = await fetch(`/api/imports/${id}`);
      if (!res.ok) {
        throw new Error(`Failed to check import status (HTTP ${res.status})`);
      }
      const data = (await res.json()) as ImportResource;
      if (data.status === 'completed') return data;
      if (data.status === 'failed') {
        throw new Error(data.error_message ?? 'Import processing failed');
      }
      const total = data.row_counts.total;
      const message =
        total > 0
          ? `Processing (${total.toLocaleString()} rows seen)`
          : 'Processing...';
      setProcessingStatus(message);
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error('Import timed out while processing');
  }

  async function fetchInitialPages(id: string): Promise<void> {
    const [summaryRes, txRes, rejRes] = await Promise.all([
      fetch(`/api/imports/${id}/summary`),
      fetch(`/api/imports/${id}/transactions?limit=${PAGE_SIZE}`),
      fetch(`/api/imports/${id}/rejected?limit=${PAGE_SIZE}`),
    ]);

    if (!summaryRes.ok || !txRes.ok || !rejRes.ok) {
      throw new Error('Failed to load import results');
    }

    const summaryData = (await summaryRes.json()) as SummaryResponse;
    const txData = (await txRes.json()) as PaginatedResponse<Transaction>;
    const rejData = (await rejRes.json()) as PaginatedResponse<RejectedRow>;

    setSummary(summaryData);
    setImported(txData.items);
    setImportedCursor(txData.next_cursor);
    setImportedHasMore(txData.has_more);
    setRejected(rejData.items);
    setRejectedCursor(rejData.next_cursor);
    setRejectedHasMore(rejData.has_more);
  }

  async function handleUpload() {
    if (!file) return;
    setUploading(true);
    setError(null);
    setProcessingStatus('Uploading...');
    setSummary(null);
    setImportId(null);
    setImported([]);
    setImportedCursor(null);
    setImportedHasMore(false);
    setRejected([]);
    setRejectedCursor(null);
    setRejectedHasMore(false);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const postRes = await fetch('/api/imports', {
        method: 'POST',
        body: formData,
      });

      if (!postRes.ok) {
        const errBody = (await postRes
          .json()
          .catch(() => ({}))) as Partial<ApiErrorBody>;
        throw new Error(
          errBody.error?.message ?? `Upload failed with HTTP ${postRes.status}`,
        );
      }

      const wasIdempotent =
        postRes.headers.get('Idempotent-Replayed') === 'true';
      const postData = (await postRes.json()) as ImportResource;
      const id = postData.id;
      setImportId(id);

      if (wasIdempotent) {
        setProcessingStatus('Duplicate detected — showing previous results');
      } else {
        setProcessingStatus('Processing...');
      }

      if (postData.status !== 'completed') {
        await pollUntilDone(id);
      }

      await fetchInitialPages(id);
      setProcessingStatus(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setProcessingStatus(null);
    } finally {
      setUploading(false);
    }
  }

  const loadMoreImported = useCallback(async () => {
    if (
      !importId ||
      importedCursor === null ||
      !importedHasMore ||
      loadingMoreImported
    ) {
      return;
    }
    setLoadingMoreImported(true);
    try {
      const res = await fetch(
        `/api/imports/${importId}/transactions?limit=${PAGE_SIZE}&cursor=${importedCursor}`,
      );
      if (!res.ok) throw new Error(`Failed to load more (HTTP ${res.status})`);
      const data = (await res.json()) as PaginatedResponse<Transaction>;
      setImported((prev) => [...prev, ...data.items]);
      setImportedCursor(data.next_cursor);
      setImportedHasMore(data.has_more);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoadingMoreImported(false);
    }
  }, [importId, importedCursor, importedHasMore, loadingMoreImported]);

  const loadMoreRejected = useCallback(async () => {
    if (
      !importId ||
      rejectedCursor === null ||
      !rejectedHasMore ||
      loadingMoreRejected
    ) {
      return;
    }
    setLoadingMoreRejected(true);
    try {
      const res = await fetch(
        `/api/imports/${importId}/rejected?limit=${PAGE_SIZE}&cursor=${rejectedCursor}`,
      );
      if (!res.ok) throw new Error(`Failed to load more (HTTP ${res.status})`);
      const data = (await res.json()) as PaginatedResponse<RejectedRow>;
      setRejected((prev) => [...prev, ...data.items]);
      setRejectedCursor(data.next_cursor);
      setRejectedHasMore(data.has_more);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoadingMoreRejected(false);
    }
  }, [importId, rejectedCursor, rejectedHasMore, loadingMoreRejected]);

  return (
    <main className="app-root">
      <header className="app-header">
        <h1 className="app-title">Ledger Import</h1>
        <p className="app-subtitle">
          Upload a CSV of journal entries. Rows that pass validation are
          imported into the ledger; rows that fail are dropped and listed
          separately with the reason.
        </p>
      </header>

      <section className="card" aria-label="Upload">
        <div className="upload-row">
          <input
            type="file"
            accept=".csv"
            onChange={handleFileChange}
            aria-label="CSV file"
            className="file-input"
          />
          <button
            type="button"
            className="button button-primary"
            onClick={handleUpload}
            disabled={!file || uploading}
          >
            {uploading ? 'Uploading...' : 'Upload CSV'}
          </button>
        </div>

        {processingStatus && (
          <div className="status-message" role="status">
            <span className="spinner" aria-hidden="true" />
            <span>{processingStatus}</span>
          </div>
        )}

        {error && (
          <div className="error-banner" role="alert">
            Error: {error}
          </div>
        )}
      </section>

      {summary && (
        <>
          <section className="card" aria-label="Import summary">
            <h2 className="card-title">Summary</h2>

            <p className="file-display">
              <strong>File:</strong> {summary.filename}
            </p>

            <div className="stat-grid">
              <div className="stat stat-total">
                <div className="stat-label">Total rows</div>
                <div className="stat-value">
                  {summary.row_counts.total.toLocaleString()}
                </div>
              </div>
              <div className="stat stat-imported">
                <div className="stat-label">Imported</div>
                <div className="stat-value">
                  {summary.row_counts.imported.toLocaleString()}
                </div>
              </div>
              <div className="stat stat-rejected">
                <div className="stat-label">Rejected</div>
                <div className="stat-value">
                  {summary.row_counts.rejected.toLocaleString()}
                </div>
              </div>
            </div>

            {/* Dot-separated category line. Kept in one text block so
                existing text-based tests still find the full string. */}
            <p className="category-line">
              <span className="cat-label-structural">
                Structural: {summary.issue_counts.by_category.structural}
              </span>
              {' · '}
              <span className="cat-label-referential">
                Referential: {summary.issue_counts.by_category.referential}
              </span>
              {' · '}
              <span className="cat-label-business">
                Business: {summary.issue_counts.by_category.business}
              </span>
            </p>

            {summary.issue_counts.by_code.length > 0 && (
              <details className="error-breakdown">
                <summary>Error code breakdown</summary>
                <ul>
                  {summary.issue_counts.by_code.map((c) => (
                    <li key={c.code}>
                      <code>{c.code}</code>
                      <span className={`cat-label-${c.category}`}>
                        {c.category}
                      </span>{' '}
                      — {c.count.toLocaleString()} × {c.message}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          <section className="card" aria-label="Imported transactions">
            <h2 className="section-heading">
              Imported transactions
              <span className="section-count">
                showing {imported.length.toLocaleString()} of{' '}
                {summary.row_counts.imported.toLocaleString()}
              </span>
            </h2>

            {imported.length === 0 ? (
              <div className="empty-state">No transactions imported.</div>
            ) : (
              <div className="table-wrap">
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>Date</th>
                        <th>Reference</th>
                        <th>Account</th>
                        <th className="num-col">Debit</th>
                        <th className="num-col">Credit</th>
                        <th>Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      {imported.map((tx) => (
                        <tr key={tx.id}>
                          <td className="row-num">{tx.row_number}</td>
                          <td className="txn-date">{tx.txn_date}</td>
                          <td>{tx.reference}</td>
                          <td className="account-code">{tx.account_code}</td>
                          <td
                            className={`num-col${tx.debit_cents === 0 ? ' zero' : ''}`}
                          >
                            {formatCents(tx.debit_cents)}
                          </td>
                          <td
                            className={`num-col${tx.credit_cents === 0 ? ' zero' : ''}`}
                          >
                            {formatCents(tx.credit_cents)}
                          </td>
                          <td>{tx.description ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {importedHasMore && (
                  <div className="load-more-bar">
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={loadMoreImported}
                      disabled={loadingMoreImported}
                    >
                      {loadingMoreImported
                        ? 'Loading...'
                        : `Load more imported (${(
                            summary.row_counts.imported - imported.length
                          ).toLocaleString()} remaining)`}
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="card" aria-label="Rejected rows">
            <h2 className="section-heading">
              Rejected rows
              <span className="section-count">
                showing {rejected.length.toLocaleString()} of{' '}
                {summary.row_counts.rejected.toLocaleString()}
              </span>
            </h2>

            {rejected.length === 0 ? (
              <div className="empty-state success">
                No rejected rows — all rows imported cleanly.
              </div>
            ) : (
              <>
                <div className="table-wrap">
                  <div className="table-scroll">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Row</th>
                          <th>Raw CSV</th>
                          <th>Errors</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rejected.map((row) => (
                          <tr key={row.id}>
                            <td className="row-num">{row.row_number}</td>
                            <td className="mono-col">{row.raw_row}</td>
                            <td>
                              <ul className="issue-list">
                                {row.issues.map((issue, idx) => (
                                  <li key={`${row.id}-${idx}`}>
                                    <span
                                      className={`issue-code ${categoryClass(issue.category)}`}
                                    >
                                      {issue.code}
                                    </span>
                                    <span className="issue-message">
                                      {issue.message}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {rejectedHasMore && (
                    <div className="load-more-bar">
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={loadMoreRejected}
                        disabled={loadingMoreRejected}
                      >
                        {loadingMoreRejected
                          ? 'Loading...'
                          : `Load more rejected (${(
                              summary.row_counts.rejected - rejected.length
                            ).toLocaleString()} remaining)`}
                      </button>
                    </div>
                  )}
                </div>
                {importId && (
                  <a
                    className="download-link"
                    href={`/api/imports/${importId}/rejected.csv`}
                  >
                    Download rejected rows (CSV)
                  </a>
                )}
              </>
            )}
          </section>
        </>
      )}
    </main>
  );
}

export default App;
