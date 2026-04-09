import type { ParsedRow, RejectionIssue } from '../../shared/types';
import { ERROR_CODES, type ErrorCode } from '../../shared/error-codes';
import {
  normalizeAmount,
  normalizeDate,
  normalizeOptionalString,
  normalizeRequiredString,
} from './normalizers';

/**
 * Raw CSV row as delivered by the parser, before any validation.
 * Every field is a string because that's what CSV gives us.
 */
export type RawRow = {
  row_number: number;
  date: string;
  reference: string;
  account_code: string;
  debit: string;
  credit: string;
  description: string;
  memo: string;
  raw_row: string;
};

export type ValidationContext = {
  /** Set of valid account codes from the seeded chart of accounts. */
  knownAccountCodes: Set<string>;
};

export type RowValidationResult =
  | { ok: true; row: ParsedRow }
  | { ok: false; issues: RejectionIssue[] };

/**
 * Build a RejectionIssue from a stable error code plus optional overrides.
 * The default message is pulled from the ERROR_CODES catalog; pass a custom
 * message when you want to include row-specific context (actual values, etc.).
 */
function makeIssue(
  code: ErrorCode,
  field: string | null,
  customMessage?: string,
  context?: Record<string, unknown>,
): RejectionIssue {
  const entry = ERROR_CODES[code];
  return {
    category: entry.category,
    code,
    field,
    message: customMessage ?? entry.message,
    context,
  };
}

/**
 * Run structural + referential + row-level business validators on a raw CSV row.
 *
 * Returns the parsed row on success, or the full list of issues on failure.
 * Unlike throw-based validation, this collects EVERY problem in one pass —
 * if a row has a bad date AND an unknown account AND a negative amount,
 * the CPA sees all three at once instead of fixing them one at a time.
 */
export function validateRow(
  raw: RawRow,
  ctx: ValidationContext,
): RowValidationResult {
  const issues: RejectionIssue[] = [];

  // ---- Structural: required string fields ----
  const refResult = normalizeRequiredString(raw.reference, 'reference');
  if (!refResult.ok) {
    issues.push(makeIssue('ERR_MISSING_REQUIRED_FIELD', 'reference'));
  }

  const acctResult = normalizeRequiredString(raw.account_code, 'account_code');
  if (!acctResult.ok) {
    issues.push(makeIssue('ERR_MISSING_REQUIRED_FIELD', 'account_code'));
  }

  // ---- Structural: date ----
  const dateResult = normalizeDate(raw.date);
  let txnDate = '';
  if (!dateResult.ok) {
    const code: ErrorCode =
      dateResult.error.code === 'ERR_MISSING_REQUIRED_FIELD'
        ? 'ERR_MISSING_REQUIRED_FIELD'
        : 'ERR_INVALID_DATE';
    issues.push(makeIssue(code, 'date', dateResult.error.message));
  } else {
    txnDate = dateResult.value;
  }

  // ---- Structural: debit / credit ----
  const debitResult = normalizeAmount(raw.debit);
  const creditResult = normalizeAmount(raw.credit);
  let debitCents = 0;
  let creditCents = 0;

  if (!debitResult.ok) {
    issues.push(
      makeIssue(
        'ERR_INVALID_AMOUNT',
        'debit',
        `Debit "${raw.debit}" could not be parsed`,
      ),
    );
  } else {
    debitCents = debitResult.value;
  }

  if (!creditResult.ok) {
    issues.push(
      makeIssue(
        'ERR_INVALID_AMOUNT',
        'credit',
        `Credit "${raw.credit}" could not be parsed`,
      ),
    );
  } else {
    creditCents = creditResult.value;
  }

  // "Both / neither populated" checks only make sense if both parsed cleanly.
  if (debitResult.ok && creditResult.ok) {
    if (debitCents > 0 && creditCents > 0) {
      issues.push(makeIssue('ERR_BOTH_DEBIT_AND_CREDIT', null));
    }
    if (debitCents === 0 && creditCents === 0) {
      issues.push(makeIssue('ERR_NEITHER_DEBIT_NOR_CREDIT', null));
    }
  }

  // ---- Business: positive amounts only ----
  if (debitResult.ok && debitCents < 0) {
    issues.push(
      makeIssue(
        'ERR_NEGATIVE_AMOUNT',
        'debit',
        `Debit amount ${formatCents(debitCents)} must be positive`,
      ),
    );
  }
  if (creditResult.ok && creditCents < 0) {
    issues.push(
      makeIssue(
        'ERR_NEGATIVE_AMOUNT',
        'credit',
        `Credit amount ${formatCents(creditCents)} must be positive`,
      ),
    );
  }

  // ---- Referential: account code must be in the chart ----
  // Only check if we successfully normalized it — otherwise we'd double-flag.
  if (acctResult.ok && !ctx.knownAccountCodes.has(acctResult.value)) {
    issues.push(
      makeIssue(
        'ERR_UNKNOWN_ACCOUNT',
        'account_code',
        `Account code "${acctResult.value}" not found in chart of accounts`,
        { account_code: acctResult.value },
      ),
    );
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  // Type narrowing — at this point all ok flags are true (otherwise we'd have
  // issues), but TypeScript can't infer that across the separate branches.
  if (!refResult.ok || !acctResult.ok || !dateResult.ok) {
    // This is unreachable given the issues.length guard above, but keeps TS happy.
    /* c8 ignore next */
    return { ok: false, issues };
  }

  return {
    ok: true,
    row: {
      row_number: raw.row_number,
      reference: refResult.value,
      txn_date: txnDate,
      account_code: acctResult.value,
      debit_cents: debitCents,
      credit_cents: creditCents,
      description: normalizeOptionalString(raw.description),
      memo: normalizeOptionalString(raw.memo),
      raw_row: raw.raw_row,
    },
  };
}

/**
 * Run group-level business validators on the set of rows that passed row
 * validation. Groups are formed by reference (the journal entry ID).
 *
 * Returns a map from row_number to the issues that apply to that row via its
 * group membership. Issues are DENORMALIZED: if JE-1001 is unbalanced, every
 * leg of JE-1001 gets the same error attached. This trades a little write cost
 * for dramatic simplification on the read path (one query surfaces every bad
 * row with its complete error story, no joins needed).
 *
 * Rules enforced:
 *  1. Every reference must have at least 2 legs.
 *  2. Sum of debits must equal sum of credits per reference.
 */
export function validateGroups(
  rows: ParsedRow[],
): Map<number, RejectionIssue[]> {
  const byRef = new Map<string, ParsedRow[]>();
  for (const row of rows) {
    const list = byRef.get(row.reference) ?? [];
    list.push(row);
    byRef.set(row.reference, list);
  }

  const result = new Map<number, RejectionIssue[]>();

  for (const [reference, legs] of byRef) {
    const groupIssues: RejectionIssue[] = [];

    if (legs.length < 2) {
      groupIssues.push(
        makeIssue(
          'ERR_SINGLE_LEG_ENTRY',
          null,
          `Journal entry ${reference} has only ${legs.length} leg; a double-entry journal must have at least 2 legs`,
          { reference, leg_count: legs.length },
        ),
      );
    } else {
      const totalDebits = legs.reduce((sum, r) => sum + r.debit_cents, 0);
      const totalCredits = legs.reduce((sum, r) => sum + r.credit_cents, 0);
      if (totalDebits !== totalCredits) {
        const diff = totalDebits - totalCredits;
        groupIssues.push(
          makeIssue(
            'ERR_UNBALANCED_ENTRY',
            null,
            `Journal entry ${reference} is unbalanced: debits ${formatCents(totalDebits)}, credits ${formatCents(totalCredits)}, difference ${formatCents(Math.abs(diff))}`,
            {
              reference,
              total_debits_cents: totalDebits,
              total_credits_cents: totalCredits,
              difference_cents: diff,
            },
          ),
        );
      }
    }

    if (groupIssues.length > 0) {
      for (const leg of legs) {
        const existing = result.get(leg.row_number) ?? [];
        result.set(leg.row_number, [...existing, ...groupIssues]);
      }
    }
  }

  return result;
}

function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${sign}$${dollars.toLocaleString('en-US')}.${String(remainder).padStart(2, '0')}`;
}
