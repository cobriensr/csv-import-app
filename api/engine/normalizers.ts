/**
 * Field normalizers for the CSV import engine.
 *
 * Each normalizer takes a raw string (exactly as it appeared in the CSV cell)
 * and returns either a clean, canonical value or a tagged error. We keep the
 * error objects lightweight here — the validator composes them into full
 * RejectionIssue records once it knows the row context.
 *
 * Design note: returning Result-style discriminated unions rather than
 * throwing lets the caller collect multiple problems per row in one pass.
 * Throwing would force early-exit and hide secondary issues from the CPA.
 */

export type NormalizationError = {
  code:
    | 'ERR_INVALID_DATE'
    | 'ERR_INVALID_AMOUNT'
    | 'ERR_MISSING_REQUIRED_FIELD';
  field: string;
  message: string;
};

export type NormalizationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: NormalizationError };

/**
 * Normalize a date string into ISO YYYY-MM-DD.
 *
 * Accepts:
 *   - YYYY-MM-DD              (ISO)
 *   - YYYY-MM-DDTHH:MM:SS...  (ISO datetime, time stripped)
 *   - YYYY-MM-DD HH:MM:SS     (common SQL-ish format, time stripped)
 *   - MM/DD/YYYY              (US format)
 *   - M/D/YYYY                (US format, single-digit month/day)
 *
 * Rejects empty strings, malformed strings, and impossible dates
 * (e.g., Feb 30, month 13).
 */
export function normalizeDate(raw: string): NormalizationResult<string> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: {
        code: 'ERR_MISSING_REQUIRED_FIELD',
        field: 'date',
        message: 'Date is required',
      },
    };
  }

  // ISO: YYYY-MM-DD optionally followed by a time portion we drop.
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    const d = Number(iso[3]);
    if (isRealCalendarDate(y, m, d)) {
      return { ok: true, value: `${iso[1]}-${iso[2]}-${iso[3]}` };
    }
  }

  // US: M/D/YYYY or MM/DD/YYYY
  const us = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) {
    const m = Number(us[1]);
    const d = Number(us[2]);
    const y = Number(us[3]);
    if (isRealCalendarDate(y, m, d)) {
      const mm = String(m).padStart(2, '0');
      const dd = String(d).padStart(2, '0');
      return { ok: true, value: `${y}-${mm}-${dd}` };
    }
  }

  return {
    ok: false,
    error: {
      code: 'ERR_INVALID_DATE',
      field: 'date',
      message: `Date "${raw}" could not be parsed`,
    },
  };
}

/**
 * True only if (y, m, d) represent a real calendar date.
 * Catches Feb 30, month 13, day 32, etc.
 */
function isRealCalendarDate(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    return false;
  }
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

/**
 * Normalize an amount string into integer cents.
 *
 * Accepts:
 *   - "250.00"         → 25000
 *   - "$250.00"        → 25000 (strips $)
 *   - "1,250.00"       → 125000 (strips commas)
 *   - "(250.00)"       → -25000 (accounting parens = negative)
 *   - "  250  "        → 25000 (whitespace tolerant)
 *   - ""               → 0 (empty is VALID — means "no debit" or "no credit")
 *
 * Integer cents is the non-negotiable money-storage rule. Floats would
 * silently corrupt totals during group validation.
 */
export function normalizeAmount(raw: string): NormalizationResult<number> {
  const trimmed = raw.trim();

  // Empty string = 0. This is on purpose: a row with only a debit has an
  // empty credit cell, and that should parse to 0, not fail.
  if (!trimmed) {
    return { ok: true, value: 0 };
  }

  let negative = false;
  let cleaned = trimmed;

  // Accounting convention: (250.00) means -$250.00
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    negative = true;
    cleaned = cleaned.slice(1, -1).trim();
  }

  // Strip currency symbols and thousands separators.
  cleaned = cleaned.replace(/[$€£,]/g, '').trim();

  if (cleaned === '') {
    return {
      ok: false,
      error: {
        code: 'ERR_INVALID_AMOUNT',
        field: 'amount',
        message: `Amount "${raw}" could not be parsed`,
      },
    };
  }

  // Reject scientific notation and other weird float syntax by requiring
  // a simple number pattern.
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    return {
      ok: false,
      error: {
        code: 'ERR_INVALID_AMOUNT',
        field: 'amount',
        message: `Amount "${raw}" could not be parsed`,
      },
    };
  }

  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n)) {
    return {
      ok: false,
      error: {
        code: 'ERR_INVALID_AMOUNT',
        field: 'amount',
        message: `Amount "${raw}" could not be parsed`,
      },
    };
  }

  // Math.round guards against float multiplication drift like 1.1 * 100 = 110.00000000000001.
  const cents = Math.round((negative ? -n : n) * 100);
  return { ok: true, value: cents };
}

/**
 * Normalize an optional string field: trim, collapse internal whitespace,
 * return null if the result is empty.
 */
export function normalizeOptionalString(raw: string): string | null {
  const cleaned = raw.trim().replace(/\s+/g, ' ');
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Normalize a required string field: trim and collapse whitespace. Returns
 * an error if the result would be empty.
 */
export function normalizeRequiredString(
  raw: string,
  fieldName: string,
): NormalizationResult<string> {
  const cleaned = raw.trim().replace(/\s+/g, ' ');
  if (!cleaned) {
    return {
      ok: false,
      error: {
        code: 'ERR_MISSING_REQUIRED_FIELD',
        field: fieldName,
        message: `${fieldName} is required`,
      },
    };
  }
  return { ok: true, value: cleaned };
}
