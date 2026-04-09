import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import App from './App';
import type {
  RejectedRow,
  SummaryResponse,
  Transaction,
} from '../shared/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type MockResponse = {
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
  headers: { get: (name: string) => string | null };
};

function mockResponse(
  body: unknown,
  ok = true,
  status = 200,
  headers: Record<string, string> = {},
): MockResponse {
  return {
    ok,
    status,
    json: async () => body,
    headers: {
      get: (name: string) =>
        headers[name] ?? headers[name.toLowerCase()] ?? null,
    },
  };
}

const postProcessingBody = {
  id: 'imp_abc123',
  filename: 'test.csv',
  status: 'processing',
  created_at: '2026-04-09T12:00:00Z',
  completed_at: null,
  error_message: null,
  row_counts: { total: 0, imported: 0, rejected: 0 },
};

const postCompletedBody = {
  id: 'imp_abc123',
  filename: 'test.csv',
  status: 'completed',
  created_at: '2026-04-09T12:00:00Z',
  completed_at: '2026-04-09T12:00:01Z',
  error_message: null,
  row_counts: { total: 3, imported: 2, rejected: 1 },
};

const summaryBody: SummaryResponse = {
  import_id: 'imp_abc123',
  filename: 'test.csv',
  status: 'completed',
  row_counts: { total: 3, imported: 2, rejected: 1 },
  issue_counts: {
    by_category: { structural: 1, referential: 0, business: 0 },
    by_code: [
      {
        code: 'ERR_INVALID_DATE',
        category: 'structural',
        count: 1,
        message: 'Date could not be parsed',
      },
    ],
  },
  links: {
    transactions: '/api/imports/imp_abc123/transactions',
    rejected: '/api/imports/imp_abc123/rejected',
    rejected_csv: '/api/imports/imp_abc123/rejected.csv',
  },
};

const transactionItems: Transaction[] = [
  {
    id: 1,
    import_id: 'imp_abc123',
    row_number: 2,
    reference: 'JE-1001',
    txn_date: '2026-01-15',
    account_code: '5100',
    debit_cents: 25000,
    credit_cents: 0,
    description: 'Office supplies',
    memo: 'Staples',
  },
  {
    id: 2,
    import_id: 'imp_abc123',
    row_number: 3,
    reference: 'JE-1001',
    txn_date: '2026-01-15',
    account_code: '1010',
    debit_cents: 0,
    credit_cents: 25000,
    description: 'Cash',
    memo: null,
  },
];

const rejectedItems: RejectedRow[] = [
  {
    id: 10,
    import_id: 'imp_abc123',
    row_number: 4,
    raw_row: 'bad,row,data',
    issues: [
      {
        category: 'structural',
        code: 'ERR_INVALID_DATE',
        field: 'date',
        message: "Date 'bad' could not be parsed",
      },
    ],
  },
];

/**
 * Build a fetch mock that handles the full upload flow:
 *   1. POST /api/imports → 202 processing
 *   2. GET /api/imports/:id → completed (single poll)
 *   3. GET summary
 *   4. GET transactions
 *   5. GET rejected
 *
 * Subsequent calls (load-more) are returned from the overrides param.
 */
function makeSuccessFetch(
  overrides: Array<MockResponse> = [],
  options: { postResponse?: MockResponse } = {},
) {
  const base = [
    options.postResponse ?? mockResponse(postProcessingBody, true, 202),
    mockResponse(postCompletedBody),
    mockResponse(summaryBody),
    mockResponse({
      items: transactionItems,
      next_cursor: null,
      has_more: false,
    }),
    mockResponse({ items: rejectedItems, next_cursor: null, has_more: false }),
    ...overrides,
  ];
  const mock = vi.fn();
  for (const r of base) mock.mockResolvedValueOnce(r);
  return mock;
}

function selectCsvFile() {
  const input = screen.getByLabelText(/csv file/i) as HTMLInputElement;
  const file = new File(['header\nrow1'], 'test.csv', { type: 'text/csv' });
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

describe('<App />', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the H1 "Ledger Import"', () => {
    render(<App />);
    expect(
      screen.getByRole('heading', { level: 1, name: /ledger import/i }),
    ).toBeInTheDocument();
  });

  it('renders the file input and upload button', () => {
    render(<App />);
    expect(screen.getByLabelText(/csv file/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /upload csv/i }),
    ).toBeInTheDocument();
  });

  it('disables the upload button when no file is selected', () => {
    render(<App />);
    expect(screen.getByRole('button', { name: /upload csv/i })).toBeDisabled();
  });

  it('enables the upload button after a file is selected', () => {
    render(<App />);
    selectCsvFile();
    expect(
      screen.getByRole('button', { name: /upload csv/i }),
    ).not.toBeDisabled();
  });

  it('posts the file, polls for completion, and renders the summary card', async () => {
    const fetchMock = makeSuccessFetch();
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    selectCsvFile();
    fireEvent.click(screen.getByRole('button', { name: /upload csv/i }));

    await waitFor(
      () => {
        expect(
          screen.getByRole('heading', { level: 2, name: /summary/i }),
        ).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // First call should be POST to /api/imports
    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall?.[0]).toBe('/api/imports');
    expect(firstCall?.[1]).toMatchObject({ method: 'POST' });

    // Second call should be the poll GET on the import
    const secondCall = fetchMock.mock.calls[1];
    expect(secondCall?.[0]).toBe('/api/imports/imp_abc123');

    expect(screen.getByText(/test\.csv/)).toBeInTheDocument();

    // The category breakdown text is split across colored spans for styling,
    // so use toHaveTextContent on the summary section (it combines descendant
    // text) instead of getByText (which only matches a single leaf element).
    const summarySection = screen.getByRole('region', {
      name: /import summary/i,
    });
    expect(summarySection).toHaveTextContent(
      /Structural: 1 · Referential: 0 · Business: 0/,
    );
  });

  it('renders imported transactions after polling completes', async () => {
    vi.stubGlobal('fetch', makeSuccessFetch());

    render(<App />);
    selectCsvFile();
    fireEvent.click(screen.getByRole('button', { name: /upload csv/i }));

    await waitFor(
      () => {
        expect(
          screen.getByRole('heading', {
            level: 2,
            name: /imported transactions/i,
          }),
        ).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    expect(screen.getByText('Office supplies')).toBeInTheDocument();
    expect(screen.getByText('Cash')).toBeInTheDocument();
    expect(screen.getAllByText('250.00').length).toBeGreaterThanOrEqual(1);
  });

  it('renders rejected rows with their error messages', async () => {
    vi.stubGlobal('fetch', makeSuccessFetch());

    render(<App />);
    selectCsvFile();
    fireEvent.click(screen.getByRole('button', { name: /upload csv/i }));

    await waitFor(
      () => {
        expect(
          screen.getByRole('heading', { level: 2, name: /rejected rows/i }),
        ).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    expect(screen.getByText('bad,row,data')).toBeInTheDocument();
    expect(
      screen.getByText(/Date 'bad' could not be parsed/),
    ).toBeInTheDocument();
  });

  it('shows a download link to the rejected CSV endpoint', async () => {
    vi.stubGlobal('fetch', makeSuccessFetch());

    render(<App />);
    selectCsvFile();
    fireEvent.click(screen.getByRole('button', { name: /upload csv/i }));

    const link = await screen.findByRole(
      'link',
      { name: /download rejected rows/i },
      { timeout: 3000 },
    );
    expect(link).toHaveAttribute(
      'href',
      '/api/imports/imp_abc123/rejected.csv',
    );
  });

  it('loads more imported rows when the Load More button is clicked', async () => {
    // First page has has_more=true and a next_cursor
    const firstTxPage = {
      items: transactionItems,
      next_cursor: 2,
      has_more: true,
    };
    const secondTxPage = {
      items: [
        {
          ...transactionItems[0]!,
          id: 3,
          row_number: 4,
          description: 'Second page row',
        },
      ],
      next_cursor: null,
      has_more: false,
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(postProcessingBody, true, 202))
      .mockResolvedValueOnce(
        mockResponse({
          ...postCompletedBody,
          row_counts: { total: 3, imported: 3, rejected: 0 },
        }),
      )
      .mockResolvedValueOnce(
        mockResponse({
          ...summaryBody,
          row_counts: { total: 3, imported: 3, rejected: 0 },
          issue_counts: {
            by_category: { structural: 0, referential: 0, business: 0 },
            by_code: [],
          },
        }),
      )
      .mockResolvedValueOnce(mockResponse(firstTxPage))
      .mockResolvedValueOnce(
        mockResponse({ items: [], next_cursor: null, has_more: false }),
      )
      .mockResolvedValueOnce(mockResponse(secondTxPage));

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    selectCsvFile();
    fireEvent.click(screen.getByRole('button', { name: /upload csv/i }));

    const loadMoreButton = await screen.findByRole(
      'button',
      { name: /load more imported/i },
      { timeout: 3000 },
    );
    fireEvent.click(loadMoreButton);

    await waitFor(() => {
      expect(screen.getByText('Second page row')).toBeInTheDocument();
    });

    // Verify the load-more call used the cursor
    const loadMoreCall = fetchMock.mock.calls[5];
    expect(loadMoreCall?.[0]).toContain('cursor=2');
  });

  it('handles the idempotent 200 case (already-completed import)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse(postCompletedBody, true, 200, {
          'Idempotent-Replayed': 'true',
        }),
      )
      .mockResolvedValueOnce(mockResponse(summaryBody))
      .mockResolvedValueOnce(
        mockResponse({
          items: transactionItems,
          next_cursor: null,
          has_more: false,
        }),
      )
      .mockResolvedValueOnce(
        mockResponse({
          items: rejectedItems,
          next_cursor: null,
          has_more: false,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    selectCsvFile();
    fireEvent.click(screen.getByRole('button', { name: /upload csv/i }));

    await waitFor(
      () => {
        expect(
          screen.getByRole('heading', { level: 2, name: /summary/i }),
        ).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // Should skip polling entirely — only 4 fetches (POST + 3 parallel GETs)
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('shows the server error message when POST returns a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        mockResponse(
          {
            error: { code: 'PAYLOAD_TOO_LARGE', message: 'File too large' },
          },
          false,
          413,
        ),
      ),
    );

    render(<App />);
    selectCsvFile();
    fireEvent.click(screen.getByRole('button', { name: /upload csv/i }));

    expect(
      await screen.findByText(/Error: File too large/),
    ).toBeInTheDocument();
  });

  it('shows an error when the background processing fails', async () => {
    const failedPoll = {
      ...postProcessingBody,
      status: 'failed',
      error_message: 'Something went wrong during processing',
    };

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(mockResponse(postProcessingBody, true, 202))
        .mockResolvedValueOnce(mockResponse(failedPoll)),
    );

    render(<App />);
    selectCsvFile();
    fireEvent.click(screen.getByRole('button', { name: /upload csv/i }));

    expect(
      await screen.findByText(/Something went wrong during processing/),
    ).toBeInTheDocument();
  });

  it('shows a generic error when fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValueOnce(new Error('Network failure')),
    );

    render(<App />);
    selectCsvFile();
    fireEvent.click(screen.getByRole('button', { name: /upload csv/i }));

    expect(
      await screen.findByText(/Error: Network failure/),
    ).toBeInTheDocument();
  });
});
