import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from './app';
import { createDatabase } from './db/index';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A balanced, fully-valid CSV. Two legs per reference, debits = credits,
// every account code is in the seeded chart of accounts.
const VALID_CSV = [
  'date,reference,account_code,debit,credit,description,memo',
  '2026-01-15,JE-1001,5100,250.00,,Office supplies,Staples order',
  '2026-01-15,JE-1001,1010,,250.00,Office supplies,Staples order',
  '2026-01-16,JE-1002,5100,100.00,,Paper,',
  '2026-01-16,JE-1002,1010,,100.00,Paper,',
].join('\n');

// A CSV where JE-2001 is unbalanced (debit 100, credit 50) and the account
// code 9999 doesn't exist — exercises business + referential categories.
const MIXED_CSV = [
  'date,reference,account_code,debit,credit,description,memo',
  '2026-01-15,JE-2000,5100,300.00,,Valid entry,',
  '2026-01-15,JE-2000,1010,,300.00,Valid entry,',
  '2026-01-16,JE-2001,5100,100.00,,Unbalanced,',
  '2026-01-16,JE-2001,1010,,50.00,Unbalanced,',
  '2026-01-17,JE-2002,9999,75.00,,Unknown account,',
  '2026-01-17,JE-2002,1010,,75.00,Unknown account,',
].join('\n');

// A second valid CSV with different references, so POST /api/imports treats
// it as a distinct (non-idempotent) upload. Used by the cursor pagination
// test for GET /api/imports, which needs 3+ distinct imports to page over.
const VALID_CSV_2 = [
  'date,reference,account_code,debit,credit,description,memo',
  '2026-02-01,JE-3001,5100,400.00,,Second batch,',
  '2026-02-01,JE-3001,1010,,400.00,Second batch,',
].join('\n');

// A CSV with many imported rows, used to exercise cursor pagination.
function buildLargeValidCsv(numJournalEntries: number): string {
  const lines: string[] = [
    'date,reference,account_code,debit,credit,description,memo',
  ];
  for (let i = 1; i <= numJournalEntries; i++) {
    const ref = `JE-${String(i).padStart(4, '0')}`;
    const amount = (i * 10).toFixed(2);
    lines.push(
      `2026-01-15,${ref},5100,${amount},,Entry ${i},`,
      `2026-01-15,${ref},1010,,${amount},Entry ${i},`,
    );
  }
  return lines.join('\n');
}

// Garbage CSV: missing required columns entirely.
const GARBAGE_CSV = 'this,is,not,a,ledger\n1,2,3,4,5';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wait for an async import to finish processing. The POST endpoint schedules
 * work via setImmediate, so we need to poll GET /api/imports/:id until the
 * row moves out of 'processing' state.
 */
async function waitForImport(
  app: Express,
  importId: string,
  maxAttempts = 100,
): Promise<{
  status: string;
  row_counts: { total: number; imported: number; rejected: number };
}> {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await request(app).get(`/api/imports/${importId}`);
    if (res.status !== 200) {
      throw new Error(`GET /api/imports/${importId} returned ${res.status}`);
    }
    if (res.body.status === 'completed' || res.body.status === 'failed') {
      return res.body;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `Import ${importId} did not finish within ${maxAttempts} polls`,
  );
}

/**
 * POST a CSV buffer and wait for processing to complete. Returns the final
 * import row (as returned by GET /api/imports/:id).
 */
async function uploadAndWait(
  app: Express,
  csv: string,
  filename: string,
): Promise<{
  postStatus: number;
  importId: string;
  final: Awaited<ReturnType<typeof waitForImport>>;
}> {
  const postRes = await request(app)
    .post('/api/imports')
    .attach('file', Buffer.from(csv), filename);

  if (postRes.status !== 202 && postRes.status !== 200) {
    throw new Error(
      `POST /api/imports returned ${postRes.status}: ${JSON.stringify(postRes.body)}`,
    );
  }

  const importId = postRes.body.id as string;
  const final = await waitForImport(app, importId);
  return { postStatus: postRes.status, importId, final };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Express app', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createDatabase(':memory:');
    app = createApp(db);
  });

  // --- Health -------------------------------------------------------------

  describe('GET /api/health', () => {
    it('returns 200 with status ok', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('responds with a JSON content-type', async () => {
      const res = await request(app).get('/api/health');
      expect(res.headers['content-type']).toMatch(/application\/json/);
    });
  });

  // --- Unknown routes -----------------------------------------------------

  describe('unknown routes', () => {
    it('returns 404 for an unknown GET endpoint', async () => {
      const res = await request(app).get('/api/this-does-not-exist');
      expect(res.status).toBe(404);
    });
  });

  // --- POST /api/imports --------------------------------------------------

  describe('POST /api/imports', () => {
    it('returns 202 with a processing status and assigns an import id', async () => {
      const res = await request(app)
        .post('/api/imports')
        .attach('file', Buffer.from(VALID_CSV), 'valid.csv');

      expect(res.status).toBe(202);
      expect(res.body.id).toMatch(/^imp_/);
      expect(res.body.filename).toBe('valid.csv');
      expect(res.body.status).toBe('processing');
      expect(res.headers.location).toBe(`/api/imports/${res.body.id}`);
    });

    it('processes a valid CSV asynchronously to completion', async () => {
      const { postStatus, final } = await uploadAndWait(
        app,
        VALID_CSV,
        'valid.csv',
      );

      expect(postStatus).toBe(202);
      expect(final.status).toBe('completed');
      expect(final.row_counts).toEqual({ total: 4, imported: 4, rejected: 0 });
    });

    it('returns 400 when no file is uploaded', async () => {
      const res = await request(app).post('/api/imports');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('returns 400 when the CSV is missing required columns (fail-fast on headers)', async () => {
      const res = await request(app)
        .post('/api/imports')
        .attach('file', Buffer.from(GARBAGE_CSV), 'garbage.csv');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toMatch(/missing required column/i);
    });

    it('returns 415 when uploading a non-CSV file', async () => {
      const res = await request(app)
        .post('/api/imports')
        .attach('file', Buffer.from('{"x":1}'), {
          filename: 'data.json',
          contentType: 'application/json',
        });

      expect(res.status).toBe(415);
      expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('still completes a CSV that contains rejected rows', async () => {
      const { final } = await uploadAndWait(app, MIXED_CSV, 'mixed.csv');
      expect(final.status).toBe('completed');
      expect(final.row_counts.total).toBe(6);
      expect(final.row_counts.rejected).toBeGreaterThan(0);
      expect(final.row_counts.imported).toBeGreaterThan(0);
    });

    it('is idempotent: re-uploading the same file returns the existing import_id with 200', async () => {
      const first = await request(app)
        .post('/api/imports')
        .attach('file', Buffer.from(VALID_CSV), 'valid.csv');
      expect(first.status).toBe(202);
      const firstId = first.body.id;
      await waitForImport(app, firstId);

      const second = await request(app)
        .post('/api/imports')
        .attach('file', Buffer.from(VALID_CSV), 'valid.csv');

      expect(second.status).toBe(200);
      expect(second.body.id).toBe(firstId);
      expect(second.headers['idempotent-replayed']).toBe('true');

      // Only one import row should exist
      const list = await request(app).get('/api/imports');
      expect(list.body.items).toHaveLength(1);
    });

    it('idempotency uses file content, not filename: same content + different names returns same id', async () => {
      const first = await request(app)
        .post('/api/imports')
        .attach('file', Buffer.from(VALID_CSV), 'name-one.csv');
      await waitForImport(app, first.body.id);

      const second = await request(app)
        .post('/api/imports')
        .attach('file', Buffer.from(VALID_CSV), 'name-two.csv');

      expect(second.body.id).toBe(first.body.id);
    });

    it('different content gets a different import_id', async () => {
      const a = await request(app)
        .post('/api/imports')
        .attach('file', Buffer.from(VALID_CSV), 'a.csv');
      await waitForImport(app, a.body.id);

      const b = await request(app)
        .post('/api/imports')
        .attach('file', Buffer.from(MIXED_CSV), 'b.csv');
      await waitForImport(app, b.body.id);

      expect(a.body.id).not.toBe(b.body.id);
    });
  });

  // --- GET /api/imports ---------------------------------------------------

  describe('GET /api/imports', () => {
    it('lists imports newest first after multiple POSTs', async () => {
      await uploadAndWait(app, VALID_CSV, 'valid.csv');
      await uploadAndWait(app, MIXED_CSV, 'mixed.csv');

      const res = await request(app).get('/api/imports');
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.items[0].filename).toBe('mixed.csv');
      expect(res.body.items[1].filename).toBe('valid.csv');
    });

    it('returns an empty list when no imports exist', async () => {
      const res = await request(app).get('/api/imports');
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
      expect(res.body.has_more).toBe(false);
      expect(res.body.next_cursor).toBeNull();
    });

    it('cursor paginates /api/imports', async () => {
      // Three distinct uploads -> three rows in imports, newest-first on list.
      await uploadAndWait(app, VALID_CSV, 'valid.csv');
      await uploadAndWait(app, MIXED_CSV, 'mixed.csv');
      await uploadAndWait(app, VALID_CSV_2, 'valid-2.csv');

      // Page 1: limit=2 -> 2 items, has_more=true, next_cursor positive.
      const page1 = await request(app)
        .get('/api/imports')
        .query({ limit: '2' });
      expect(page1.status).toBe(200);
      expect(page1.body.items).toHaveLength(2);
      expect(page1.body.has_more).toBe(true);
      expect(page1.body.next_cursor).toBeGreaterThan(0);
      // Newest first: valid-2.csv (rowid 3) before mixed.csv (rowid 2).
      expect(page1.body.items[0].filename).toBe('valid-2.csv');
      expect(page1.body.items[1].filename).toBe('mixed.csv');

      // Page 2: feed next_cursor back in -> 1 item, has_more=false.
      const page2 = await request(app)
        .get('/api/imports')
        .query({ limit: '2', cursor: String(page1.body.next_cursor) });
      expect(page2.status).toBe(200);
      expect(page2.body.items).toHaveLength(1);
      expect(page2.body.has_more).toBe(false);
      expect(page2.body.next_cursor).toBeNull();
      expect(page2.body.items[0].filename).toBe('valid.csv');
    });
  });

  // --- GET /api/imports/:id -----------------------------------------------

  describe('GET /api/imports/:id', () => {
    it('returns the import by id', async () => {
      const { importId } = await uploadAndWait(app, VALID_CSV, 'valid.csv');
      const res = await request(app).get(`/api/imports/${importId}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(importId);
      expect(res.body.status).toBe('completed');
      expect(res.body.row_counts.imported).toBe(4);
    });

    it('returns 404 for an unknown import id', async () => {
      const res = await request(app).get('/api/imports/imp_nope');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(res.body.error.message).toBe('Import not found');
    });
  });

  // --- GET /api/imports/:id/summary ---------------------------------------

  describe('GET /api/imports/:id/summary', () => {
    it('returns a rich summary with by_category and by_code', async () => {
      const { importId } = await uploadAndWait(app, MIXED_CSV, 'mixed.csv');
      const res = await request(app).get(`/api/imports/${importId}/summary`);

      expect(res.status).toBe(200);
      expect(res.body.import_id).toBe(importId);
      expect(res.body.filename).toBe('mixed.csv');
      expect(res.body.row_counts.total).toBe(6);
      expect(res.body.issue_counts.by_category).toHaveProperty('structural');
      expect(res.body.issue_counts.by_category).toHaveProperty('referential');
      expect(res.body.issue_counts.by_category).toHaveProperty('business');
      expect(res.body.issue_counts.by_category.referential).toBeGreaterThan(0);
      expect(Array.isArray(res.body.issue_counts.by_code)).toBe(true);
      expect(res.body.links.transactions).toBe(
        `/api/imports/${importId}/transactions`,
      );
    });

    it('defaults all three category counts to 0 when there are no rejections', async () => {
      const { importId } = await uploadAndWait(app, VALID_CSV, 'valid.csv');
      const res = await request(app).get(`/api/imports/${importId}/summary`);
      expect(res.body.issue_counts.by_category).toEqual({
        structural: 0,
        referential: 0,
        business: 0,
      });
      expect(res.body.issue_counts.by_code).toEqual([]);
    });

    it('returns 404 for an unknown import id', async () => {
      const res = await request(app).get('/api/imports/imp_nope/summary');
      expect(res.status).toBe(404);
    });
  });

  // --- GET /api/imports/:id/transactions ----------------------------------

  describe('GET /api/imports/:id/transactions', () => {
    it('returns imported rows', async () => {
      const { importId } = await uploadAndWait(app, VALID_CSV, 'valid.csv');
      const res = await request(app).get(
        `/api/imports/${importId}/transactions`,
      );
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(4);
      expect(res.body.items[0]).toHaveProperty('row_number');
      expect(res.body.items[0]).toHaveProperty('reference');
      expect(res.body.next_cursor).toBeNull();
      expect(res.body.has_more).toBe(false);
    });

    it('filters by reference', async () => {
      const { importId } = await uploadAndWait(app, VALID_CSV, 'valid.csv');
      const res = await request(app)
        .get(`/api/imports/${importId}/transactions`)
        .query({ reference: 'JE-1001' });
      expect(res.body.items).toHaveLength(2);
      for (const item of res.body.items) {
        expect(item.reference).toBe('JE-1001');
      }
    });

    it('filters by account_code', async () => {
      const { importId } = await uploadAndWait(app, VALID_CSV, 'valid.csv');
      const res = await request(app)
        .get(`/api/imports/${importId}/transactions`)
        .query({ account_code: '5100' });
      expect(res.body.items).toHaveLength(2);
      for (const item of res.body.items) {
        expect(item.account_code).toBe('5100');
      }
    });

    it('cursor paginates through a large result set', async () => {
      // 30 journal entries = 60 transaction legs
      const csv = buildLargeValidCsv(30);
      const { importId, final } = await uploadAndWait(app, csv, 'large.csv');
      expect(final.row_counts.imported).toBe(60);

      // Page 1: limit 25 → should return 25 items with has_more=true
      const page1 = await request(app)
        .get(`/api/imports/${importId}/transactions`)
        .query({ limit: '25' });
      expect(page1.body.items).toHaveLength(25);
      expect(page1.body.has_more).toBe(true);
      expect(page1.body.next_cursor).toBeGreaterThan(0);

      // Page 2: use the cursor from page 1
      const page2 = await request(app)
        .get(`/api/imports/${importId}/transactions`)
        .query({ limit: '25', cursor: String(page1.body.next_cursor) });
      expect(page2.body.items).toHaveLength(25);
      expect(page2.body.has_more).toBe(true);

      // Page 3: last page, should have 10 items and has_more=false
      const page3 = await request(app)
        .get(`/api/imports/${importId}/transactions`)
        .query({ limit: '25', cursor: String(page2.body.next_cursor) });
      expect(page3.body.items).toHaveLength(10);
      expect(page3.body.has_more).toBe(false);
      expect(page3.body.next_cursor).toBeNull();

      // Pages should not overlap: first id of page 2 > last id of page 1
      const page1LastId = page1.body.items[24].id;
      const page2FirstId = page2.body.items[0].id;
      expect(page2FirstId).toBeGreaterThan(page1LastId);
    });

    it('returns 404 for an unknown import id', async () => {
      const res = await request(app).get('/api/imports/imp_nope/transactions');
      expect(res.status).toBe(404);
    });
  });

  // --- GET /api/imports/:id/rejected --------------------------------------

  describe('GET /api/imports/:id/rejected', () => {
    it('returns rejected rows with their issues array', async () => {
      const { importId } = await uploadAndWait(app, MIXED_CSV, 'mixed.csv');
      const res = await request(app).get(`/api/imports/${importId}/rejected`);
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      const first = res.body.items[0];
      expect(first).toHaveProperty('row_number');
      expect(first).toHaveProperty('raw_row');
      expect(Array.isArray(first.issues)).toBe(true);
      expect(first.issues[0]).toHaveProperty('code');
      expect(first.issues[0]).toHaveProperty('message');
    });

    it('filters by category', async () => {
      const { importId } = await uploadAndWait(app, MIXED_CSV, 'mixed.csv');
      const res = await request(app)
        .get(`/api/imports/${importId}/rejected`)
        .query({ category: 'referential' });
      expect(res.status).toBe(200);
      for (const item of res.body.items) {
        expect(
          item.issues.some(
            (i: { category: string }) => i.category === 'referential',
          ),
        ).toBe(true);
      }
    });

    it('filters by code', async () => {
      const { importId } = await uploadAndWait(app, MIXED_CSV, 'mixed.csv');
      const res = await request(app)
        .get(`/api/imports/${importId}/rejected`)
        .query({ code: 'ERR_UNKNOWN_ACCOUNT' });
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThan(0);
    });

    it('returns 400 when category filter is invalid', async () => {
      const { importId } = await uploadAndWait(app, MIXED_CSV, 'mixed.csv');
      const res = await request(app)
        .get(`/api/imports/${importId}/rejected`)
        .query({ category: 'nonsense' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toMatch(/structural/);
      expect(res.body.error.message).toMatch(/referential/);
      expect(res.body.error.message).toMatch(/business/);
    });

    it('returns an empty list when there are no rejections', async () => {
      const { importId } = await uploadAndWait(app, VALID_CSV, 'valid.csv');
      const res = await request(app).get(`/api/imports/${importId}/rejected`);
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
      expect(res.body.has_more).toBe(false);
      expect(res.body.next_cursor).toBeNull();
    });

    it('returns 404 for an unknown import id', async () => {
      const res = await request(app).get('/api/imports/imp_nope/rejected');
      expect(res.status).toBe(404);
    });
  });

  // --- GET /api/imports/:id/rejected.csv ----------------------------------

  describe('GET /api/imports/:id/rejected.csv', () => {
    it('returns a CSV with the correct headers and rows', async () => {
      const { importId } = await uploadAndWait(app, MIXED_CSV, 'mixed.csv');
      const res = await request(app).get(
        `/api/imports/${importId}/rejected.csv`,
      );
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.text).toContain(
        'row_number,raw_row,error_codes,error_messages',
      );
      expect(res.text).toContain('ERR_');
    });

    it('returns a header-only CSV when there are no rejections', async () => {
      const { importId } = await uploadAndWait(app, VALID_CSV, 'valid.csv');
      const res = await request(app).get(
        `/api/imports/${importId}/rejected.csv`,
      );
      expect(res.status).toBe(200);
      expect(res.text).toBe('row_number,raw_row,error_codes,error_messages');
    });

    it('returns 404 for an unknown import id', async () => {
      const res = await request(app).get('/api/imports/imp_nope/rejected.csv');
      expect(res.status).toBe(404);
    });
  });
});
