import { describe, it, expect } from 'vitest';
import {
  normalizeDate,
  normalizeAmount,
  normalizeOptionalString,
  normalizeRequiredString,
} from './normalizers';

describe('normalizeDate', () => {
  it('accepts ISO format YYYY-MM-DD', () => {
    const result = normalizeDate('2026-04-09');
    expect(result).toEqual({ ok: true, value: '2026-04-09' });
  });

  it('accepts ISO datetime and strips the time portion', () => {
    const result = normalizeDate('2026-04-09T12:34:56Z');
    expect(result).toEqual({ ok: true, value: '2026-04-09' });
  });

  it('accepts SQL-style datetime with a space separator', () => {
    const result = normalizeDate('2026-04-09 12:34:56');
    expect(result).toEqual({ ok: true, value: '2026-04-09' });
  });

  it('accepts US format MM/DD/YYYY', () => {
    const result = normalizeDate('04/09/2026');
    expect(result).toEqual({ ok: true, value: '2026-04-09' });
  });

  it('accepts US format with single-digit month and day', () => {
    const result = normalizeDate('4/9/2026');
    expect(result).toEqual({ ok: true, value: '2026-04-09' });
  });

  it('tolerates leading and trailing whitespace', () => {
    const result = normalizeDate('   2026-04-09   ');
    expect(result).toEqual({ ok: true, value: '2026-04-09' });
  });

  it('rejects empty string as missing required field', () => {
    const result = normalizeDate('');
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.code).toBe('ERR_MISSING_REQUIRED_FIELD');
  });

  it('rejects whitespace-only as missing required field', () => {
    const result = normalizeDate('   ');
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.code).toBe('ERR_MISSING_REQUIRED_FIELD');
  });

  it('rejects garbage strings as invalid date', () => {
    const result = normalizeDate('not-a-date');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ERR_INVALID_DATE');
  });

  it('rejects impossible dates: Feb 30', () => {
    const result = normalizeDate('2026-02-30');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ERR_INVALID_DATE');
  });

  it('rejects impossible dates: month 13', () => {
    const result = normalizeDate('2026-13-01');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ERR_INVALID_DATE');
  });

  it('rejects impossible dates: day 32', () => {
    const result = normalizeDate('2026-01-32');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ERR_INVALID_DATE');
  });

  it('accepts leap year Feb 29 in 2024', () => {
    const result = normalizeDate('2024-02-29');
    expect(result).toEqual({ ok: true, value: '2024-02-29' });
  });

  it('rejects Feb 29 in a non-leap year', () => {
    const result = normalizeDate('2025-02-29');
    expect(result.ok).toBe(false);
  });

  it('rejects completely wrong format', () => {
    const result = normalizeDate('April 9, 2026');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ERR_INVALID_DATE');
  });
});

describe('normalizeAmount', () => {
  it('parses a plain decimal string to integer cents', () => {
    expect(normalizeAmount('250.00')).toEqual({ ok: true, value: 25000 });
  });

  it('parses an integer string to cents', () => {
    expect(normalizeAmount('250')).toEqual({ ok: true, value: 25000 });
  });

  it('strips a leading dollar sign', () => {
    expect(normalizeAmount('$250.00')).toEqual({ ok: true, value: 25000 });
  });

  it('strips thousands-separator commas', () => {
    expect(normalizeAmount('1,250.50')).toEqual({ ok: true, value: 125050 });
  });

  it('handles both $ and , together', () => {
    expect(normalizeAmount('$1,250,000.99')).toEqual({
      ok: true,
      value: 125000099,
    });
  });

  it('interprets parentheses as negative (accounting notation)', () => {
    expect(normalizeAmount('(250.00)')).toEqual({ ok: true, value: -25000 });
  });

  it('handles a negative sign prefix', () => {
    expect(normalizeAmount('-250.00')).toEqual({ ok: true, value: -25000 });
  });

  it('treats empty string as zero', () => {
    expect(normalizeAmount('')).toEqual({ ok: true, value: 0 });
  });

  it('treats whitespace-only as zero', () => {
    expect(normalizeAmount('   ')).toEqual({ ok: true, value: 0 });
  });

  it('trims whitespace around the number', () => {
    expect(normalizeAmount('  250.00  ')).toEqual({ ok: true, value: 25000 });
  });

  it('rejects non-numeric strings', () => {
    const result = normalizeAmount('abc');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ERR_INVALID_AMOUNT');
  });

  it('rejects mixed numeric and text', () => {
    const result = normalizeAmount('250 dollars');
    expect(result.ok).toBe(false);
  });

  it('rejects scientific notation', () => {
    const result = normalizeAmount('1e5');
    expect(result.ok).toBe(false);
  });

  it('rejects empty parens', () => {
    const result = normalizeAmount('()');
    expect(result.ok).toBe(false);
  });

  it('avoids float-rounding drift on repeating decimals', () => {
    // 1.1 * 100 in IEEE 754 is 110.00000000000001; Math.round saves us.
    expect(normalizeAmount('1.10')).toEqual({ ok: true, value: 110 });
  });

  it('handles very large amounts', () => {
    expect(normalizeAmount('999999999.99')).toEqual({
      ok: true,
      value: 99999999999,
    });
  });

  it('strips euro and pound currency symbols', () => {
    expect(normalizeAmount('€250.00')).toEqual({ ok: true, value: 25000 });
    expect(normalizeAmount('£250.00')).toEqual({ ok: true, value: 25000 });
  });
});

describe('normalizeOptionalString', () => {
  it('trims whitespace', () => {
    expect(normalizeOptionalString('  hello  ')).toBe('hello');
  });

  it('collapses internal whitespace to single spaces', () => {
    expect(normalizeOptionalString('hello   world\t\ttest')).toBe(
      'hello world test',
    );
  });

  it('returns null for empty string', () => {
    expect(normalizeOptionalString('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(normalizeOptionalString('   \t\n  ')).toBeNull();
  });

  it('preserves a single non-empty word', () => {
    expect(normalizeOptionalString('rent')).toBe('rent');
  });
});

describe('normalizeRequiredString', () => {
  it('trims and returns the value when non-empty', () => {
    expect(normalizeRequiredString('  JE-1001  ', 'reference')).toEqual({
      ok: true,
      value: 'JE-1001',
    });
  });

  it('collapses internal whitespace', () => {
    expect(normalizeRequiredString('JE  1001', 'reference')).toEqual({
      ok: true,
      value: 'JE 1001',
    });
  });

  it('rejects empty string with the field name in the error', () => {
    const result = normalizeRequiredString('', 'reference');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('ERR_MISSING_REQUIRED_FIELD');
      expect(result.error.field).toBe('reference');
      expect(result.error.message).toContain('reference');
    }
  });

  it('rejects whitespace-only string', () => {
    const result = normalizeRequiredString('   ', 'account_code');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toBe('account_code');
  });
});
