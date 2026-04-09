import type { ValidationCategory } from './types';

type ErrorCodeEntry = {
  category: ValidationCategory;
  message: string;
};

/**
 * Stable, machine-readable error codes for validation failures.
 *
 * Consumers (engine, routes, UI) should import ERROR_CODES rather than
 * hardcode code strings, so rename refactors propagate cleanly.
 */
export const ERROR_CODES = {
  // --- Structural: parse / type errors ----------------------------------
  ERR_INVALID_DATE: {
    category: 'structural',
    message: 'Date could not be parsed',
  },
  ERR_INVALID_AMOUNT: {
    category: 'structural',
    message: 'Amount could not be parsed as a number',
  },
  ERR_BOTH_DEBIT_AND_CREDIT: {
    category: 'structural',
    message: 'Both debit and credit are populated on the same row',
  },
  ERR_NEITHER_DEBIT_NOR_CREDIT: {
    category: 'structural',
    message: 'Neither debit nor credit is populated',
  },
  ERR_MISSING_REQUIRED_FIELD: {
    category: 'structural',
    message: 'A required field is missing',
  },

  // --- Referential: unknown lookup --------------------------------------
  ERR_UNKNOWN_ACCOUNT: {
    category: 'referential',
    message: 'Account code not found in chart of accounts',
  },

  // --- Business: domain rules -------------------------------------------
  ERR_NEGATIVE_AMOUNT: {
    category: 'business',
    message: 'Amount must be positive',
  },
  ERR_UNBALANCED_ENTRY: {
    category: 'business',
    message: 'Journal entry debits do not equal credits',
  },
  ERR_SINGLE_LEG_ENTRY: {
    category: 'business',
    message: 'Journal entry must have at least two legs',
  },
} as const satisfies Record<string, ErrorCodeEntry>;

export type ErrorCode = keyof typeof ERROR_CODES;
