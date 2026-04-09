import { describe, it, expect } from 'vitest';
import {
  validateRow,
  validateGroups,
  type RawRow,
  type ValidationContext,
} from './validators';
import type { ParsedRow } from '../../shared/types';

const knownAccounts = new Set(['1010', '5100', '5200', '4010']);
const ctx: ValidationContext = { knownAccountCodes: knownAccounts };

function goodRow(overrides: Partial<RawRow> = {}): RawRow {
  return {
    row_number: 1,
    date: '2026-01-15',
    reference: 'JE-1001',
    account_code: '5100',
    debit: '250.00',
    credit: '',
    description: 'Office supplies',
    memo: 'Staples',
    raw_row: '2026-01-15,JE-1001,5100,250.00,,Office supplies,Staples',
    ...overrides,
  };
}

describe('validateRow', () => {
  it('accepts a well-formed debit row', () => {
    const result = validateRow(goodRow(), ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.row).toMatchObject({
        row_number: 1,
        reference: 'JE-1001',
        txn_date: '2026-01-15',
        account_code: '5100',
        debit_cents: 25000,
        credit_cents: 0,
        description: 'Office supplies',
        memo: 'Staples',
      });
    }
  });

  it('accepts a well-formed credit row', () => {
    const result = validateRow(
      goodRow({ debit: '', credit: '250.00', account_code: '1010' }),
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.row.debit_cents).toBe(0);
      expect(result.row.credit_cents).toBe(25000);
    }
  });

  it('normalizes date from US format to ISO', () => {
    const result = validateRow(goodRow({ date: '01/15/2026' }), ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.row.txn_date).toBe('2026-01-15');
  });

  it('normalizes amounts with currency symbols and commas', () => {
    const result = validateRow(goodRow({ debit: '$1,250.00' }), ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.row.debit_cents).toBe(125000);
  });

  it('flags missing reference', () => {
    const result = validateRow(goodRow({ reference: '' }), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((i) => i.code === 'ERR_MISSING_REQUIRED_FIELD'),
      ).toBe(true);
    }
  });

  it('flags missing account_code', () => {
    const result = validateRow(goodRow({ account_code: '' }), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some(
          (i) =>
            i.code === 'ERR_MISSING_REQUIRED_FIELD' &&
            i.field === 'account_code',
        ),
      ).toBe(true);
    }
  });

  it('flags invalid date', () => {
    const result = validateRow(goodRow({ date: 'garbage' }), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'ERR_INVALID_DATE')).toBe(
        true,
      );
    }
  });

  it('flags empty date as missing required field', () => {
    const result = validateRow(goodRow({ date: '' }), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((i) => i.code === 'ERR_MISSING_REQUIRED_FIELD'),
      ).toBe(true);
    }
  });

  it('flags unparseable debit amount', () => {
    const result = validateRow(goodRow({ debit: 'abc' }), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some(
          (i) => i.code === 'ERR_INVALID_AMOUNT' && i.field === 'debit',
        ),
      ).toBe(true);
    }
  });

  it('flags unparseable credit amount', () => {
    const result = validateRow(goodRow({ credit: 'xyz', debit: '' }), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some(
          (i) => i.code === 'ERR_INVALID_AMOUNT' && i.field === 'credit',
        ),
      ).toBe(true);
    }
  });

  it('flags both debit and credit populated on the same row', () => {
    const result = validateRow(
      goodRow({ debit: '250.00', credit: '250.00' }),
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((i) => i.code === 'ERR_BOTH_DEBIT_AND_CREDIT'),
      ).toBe(true);
    }
  });

  it('flags neither debit nor credit populated', () => {
    const result = validateRow(goodRow({ debit: '', credit: '' }), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((i) => i.code === 'ERR_NEITHER_DEBIT_NOR_CREDIT'),
      ).toBe(true);
    }
  });

  it('flags negative debit amount', () => {
    const result = validateRow(goodRow({ debit: '(250.00)' }), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some(
          (i) => i.code === 'ERR_NEGATIVE_AMOUNT' && i.field === 'debit',
        ),
      ).toBe(true);
    }
  });

  it('flags negative credit amount', () => {
    const result = validateRow(
      goodRow({ debit: '', credit: '(250.00)', account_code: '1010' }),
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some(
          (i) => i.code === 'ERR_NEGATIVE_AMOUNT' && i.field === 'credit',
        ),
      ).toBe(true);
    }
  });

  it('flags unknown account code', () => {
    const result = validateRow(goodRow({ account_code: '9999' }), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'ERR_UNKNOWN_ACCOUNT')).toBe(
        true,
      );
    }
  });

  it('collects multiple issues on the same row in one pass', () => {
    const result = validateRow(
      goodRow({
        date: 'nope',
        account_code: 'FAKE',
        debit: 'xyz',
      }),
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Should catch: invalid date + unknown account + invalid amount
      expect(result.issues.length).toBeGreaterThanOrEqual(3);
      const codes = result.issues.map((i) => i.code);
      expect(codes).toContain('ERR_INVALID_DATE');
      expect(codes).toContain('ERR_INVALID_AMOUNT');
    }
  });

  it('preserves the raw CSV row on successful parse', () => {
    const row = goodRow({ raw_row: 'this,is,the,raw,line' });
    const result = validateRow(row, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.row.raw_row).toBe('this,is,the,raw,line');
  });

  it('normalizes whitespace in description and memo', () => {
    const result = validateRow(
      goodRow({ description: '  Office   supplies  ', memo: '  ' }),
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.row.description).toBe('Office supplies');
      expect(result.row.memo).toBeNull();
    }
  });
});

describe('validateGroups', () => {
  function parsedRow(overrides: Partial<ParsedRow>): ParsedRow {
    return {
      row_number: 1,
      reference: 'JE-1001',
      txn_date: '2026-01-15',
      account_code: '5100',
      debit_cents: 25000,
      credit_cents: 0,
      description: null,
      memo: null,
      raw_row: '',
      ...overrides,
    };
  }

  it('returns no issues when a group is balanced', () => {
    const rows = [
      parsedRow({ row_number: 1, debit_cents: 25000, credit_cents: 0 }),
      parsedRow({
        row_number: 2,
        account_code: '1010',
        debit_cents: 0,
        credit_cents: 25000,
      }),
    ];
    const result = validateGroups(rows);
    expect(result.size).toBe(0);
  });

  it('flags an unbalanced group on every leg', () => {
    const rows = [
      parsedRow({ row_number: 1, debit_cents: 25000, credit_cents: 0 }),
      parsedRow({
        row_number: 2,
        account_code: '1010',
        debit_cents: 0,
        credit_cents: 20000,
      }),
    ];
    const result = validateGroups(rows);
    expect(result.size).toBe(2);
    const issuesFor1 = result.get(1) ?? [];
    const issuesFor2 = result.get(2) ?? [];
    expect(issuesFor1.some((i) => i.code === 'ERR_UNBALANCED_ENTRY')).toBe(
      true,
    );
    expect(issuesFor2.some((i) => i.code === 'ERR_UNBALANCED_ENTRY')).toBe(
      true,
    );
  });

  it('includes debit/credit totals in the unbalanced error context', () => {
    const rows = [
      parsedRow({ row_number: 1, debit_cents: 25000, credit_cents: 0 }),
      parsedRow({
        row_number: 2,
        account_code: '1010',
        debit_cents: 0,
        credit_cents: 20000,
      }),
    ];
    const result = validateGroups(rows);
    const issue = result.get(1)?.[0];
    expect(issue?.context).toMatchObject({
      reference: 'JE-1001',
      total_debits_cents: 25000,
      total_credits_cents: 20000,
      difference_cents: 5000,
    });
  });

  it('flags a single-leg group', () => {
    const rows = [
      parsedRow({ row_number: 1, reference: 'JE-2', debit_cents: 25000 }),
    ];
    const result = validateGroups(rows);
    const issues = result.get(1) ?? [];
    expect(issues.some((i) => i.code === 'ERR_SINGLE_LEG_ENTRY')).toBe(true);
  });

  it('handles multiple groups independently', () => {
    const rows = [
      // Balanced group JE-1
      parsedRow({ row_number: 1, reference: 'JE-1', debit_cents: 10000 }),
      parsedRow({
        row_number: 2,
        reference: 'JE-1',
        account_code: '1010',
        debit_cents: 0,
        credit_cents: 10000,
      }),
      // Unbalanced group JE-2
      parsedRow({ row_number: 3, reference: 'JE-2', debit_cents: 20000 }),
      parsedRow({
        row_number: 4,
        reference: 'JE-2',
        account_code: '1010',
        debit_cents: 0,
        credit_cents: 15000,
      }),
    ];
    const result = validateGroups(rows);

    // JE-1 is clean
    expect(result.has(1)).toBe(false);
    expect(result.has(2)).toBe(false);

    // JE-2 is flagged on both legs
    expect(result.has(3)).toBe(true);
    expect(result.has(4)).toBe(true);
  });

  it('handles a 3-leg balanced entry (2 debits, 1 credit)', () => {
    const rows = [
      parsedRow({ row_number: 1, debit_cents: 10000, credit_cents: 0 }),
      parsedRow({
        row_number: 2,
        account_code: '5200',
        debit_cents: 15000,
        credit_cents: 0,
      }),
      parsedRow({
        row_number: 3,
        account_code: '1010',
        debit_cents: 0,
        credit_cents: 25000,
      }),
    ];
    const result = validateGroups(rows);
    expect(result.size).toBe(0);
  });

  it('formats the unbalanced error message with a dollar-sign total', () => {
    const rows = [
      parsedRow({ row_number: 1, debit_cents: 150000, credit_cents: 0 }),
      parsedRow({
        row_number: 2,
        account_code: '1010',
        debit_cents: 0,
        credit_cents: 100000,
      }),
    ];
    const result = validateGroups(rows);
    const issue = result.get(1)?.[0];
    expect(issue?.message).toContain('$1,500.00');
    expect(issue?.message).toContain('$1,000.00');
    expect(issue?.message).toContain('$500.00');
  });
});
