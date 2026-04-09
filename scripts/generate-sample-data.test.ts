/**
 * Tests for the sample-data generator. These cover the helpers in
 * `generate-sample-data.ts` that have non-trivial logic: the seeded PRNG,
 * amount and CSV formatting, the `twoLeg` factory, and the end-to-end
 * `generateEntries` pipeline.
 *
 * The integration test is the load-bearing one: it generates a small batch
 * of entries and verifies every invariant the engine will later check —
 * balanced debits/credits, known account codes, min-two-legs per entry, and
 * dates inside the requested window. If any scenario gets misconfigured,
 * that test fails immediately without needing to regenerate the full 250k
 * fixtures.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  addThousandsSeparators,
  csvField,
  csvRow,
  formatAmount,
  generateEntries,
  mulberry32,
  pickScenario,
  SCENARIOS,
  twoLeg,
  type Leg,
} from './generate-sample-data';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHART = JSON.parse(
  readFileSync(join(HERE, '..', 'data', 'chart-of-accounts.json'), 'utf-8'),
) as { code: string }[];
const VALID_CODES = new Set(CHART.map((a) => a.code));

/** Stub RNG that replays the given values in order (and wraps if exhausted). */
function fakeRng(values: readonly number[]): () => number {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i += 1;
    return v ?? 0;
  };
}

function sumLegs(legs: readonly Leg[]): { debit: number; credit: number } {
  let debit = 0;
  let credit = 0;
  for (const leg of legs) {
    debit += leg.debit;
    credit += leg.credit;
  }
  return { debit, credit };
}

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    for (let i = 0; i < 20; i += 1) {
      expect(a()).toBe(b());
    }
  });

  it('produces different streams for different seeds', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    // Extremely unlikely for the first 5 values to collide.
    const aVals = [a(), a(), a(), a(), a()];
    const bVals = [b(), b(), b(), b(), b()];
    expect(aVals).not.toEqual(bVals);
  });

  it('returns values in [0, 1)', () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 100; i += 1) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('addThousandsSeparators', () => {
  it('leaves short integers untouched', () => {
    expect(addThousandsSeparators('0')).toBe('0');
    expect(addThousandsSeparators('7')).toBe('7');
    expect(addThousandsSeparators('123')).toBe('123');
  });

  it('inserts a separator every three digits from the right', () => {
    expect(addThousandsSeparators('1234')).toBe('1,234');
    expect(addThousandsSeparators('12345')).toBe('12,345');
    expect(addThousandsSeparators('123456')).toBe('123,456');
    expect(addThousandsSeparators('1234567')).toBe('1,234,567');
    expect(addThousandsSeparators('12345678901')).toBe('12,345,678,901');
  });
});

describe('formatAmount', () => {
  it('renders plain decimals when the first rng call is below 0.4', () => {
    expect(formatAmount(123456, fakeRng([0.1]))).toBe('1234.56');
    expect(formatAmount(5, fakeRng([0.0]))).toBe('0.05');
  });

  it('renders $-prefixed with commas when 0.4 <= r < 0.7', () => {
    expect(formatAmount(123456, fakeRng([0.5]))).toBe('$1,234.56');
    expect(formatAmount(99, fakeRng([0.4]))).toBe('$0.99');
  });

  it('renders commas without $ when 0.7 <= r < 0.85', () => {
    expect(formatAmount(123456, fakeRng([0.8]))).toBe('1,234.56');
  });

  it('renders $ and commas when r >= 0.85', () => {
    expect(formatAmount(123456, fakeRng([0.95]))).toBe('$1,234.56');
  });

  it('always produces a value that parses back to the original cents', () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 200; i += 1) {
      const cents = Math.floor(rng() * 10_000_000);
      const formatted = formatAmount(cents, rng);
      const numeric = Number(formatted.replace(/[$,]/g, ''));
      expect(Math.round(numeric * 100)).toBe(cents);
    }
  });
});

describe('csvField', () => {
  it('passes plain strings through unchanged', () => {
    expect(csvField('hello')).toBe('hello');
    expect(csvField('1234.56')).toBe('1234.56');
    expect(csvField('')).toBe('');
  });

  it('quotes strings containing a comma', () => {
    expect(csvField('$1,234.56')).toBe('"$1,234.56"');
  });

  it('quotes and escapes embedded double quotes', () => {
    expect(csvField('she said "hi"')).toBe('"she said ""hi"""');
  });

  it('quotes strings containing newlines', () => {
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
  });
});

describe('csvRow', () => {
  it('joins fields with commas and escapes per field', () => {
    expect(csvRow(['a', 'b', 'c'])).toBe('a,b,c');
    expect(csvRow(['plain', '$1,234.00', 'note'])).toBe(
      'plain,"$1,234.00",note',
    );
  });
});

describe('twoLeg factory', () => {
  it('produces one debit and one offsetting credit for the same amount', () => {
    const scenario = twoLeg('Test', ['memo'], 1, '5200', '1010', 100, 100);
    const legs = scenario.generate(fakeRng([0]));
    expect(legs).toHaveLength(2);
    const { debit, credit } = sumLegs(legs);
    expect(debit).toBe(credit);
    expect(legs[0]?.account).toBe('5200');
    expect(legs[0]?.debit).toBeGreaterThan(0);
    expect(legs[0]?.credit).toBe(0);
    expect(legs[1]?.account).toBe('1010');
    expect(legs[1]?.debit).toBe(0);
    expect(legs[1]?.credit).toBeGreaterThan(0);
  });

  it('samples amounts inside the requested range', () => {
    const scenario = twoLeg('Test', ['memo'], 1, '5200', '1010', 500, 1000);
    const rng = mulberry32(7);
    for (let i = 0; i < 50; i += 1) {
      const legs = scenario.generate(rng);
      const amt = legs[0]?.debit ?? 0;
      expect(amt).toBeGreaterThanOrEqual(500);
      expect(amt).toBeLessThanOrEqual(1000);
    }
  });
});

describe('SCENARIOS', () => {
  it('every scenario generates balanced legs across many amount samples', () => {
    const rng = mulberry32(1234);
    for (const scenario of SCENARIOS) {
      for (let i = 0; i < 20; i += 1) {
        const legs = scenario.generate(rng);
        expect(legs.length).toBeGreaterThanOrEqual(2);
        const { debit, credit } = sumLegs(legs);
        expect(debit).toBe(credit);
        for (const leg of legs) {
          expect(leg.debit).toBeGreaterThanOrEqual(0);
          expect(leg.credit).toBeGreaterThanOrEqual(0);
          // Each leg hits exactly one side — never both, never neither.
          expect(leg.debit > 0 || leg.credit > 0).toBe(true);
          expect(leg.debit > 0 && leg.credit > 0).toBe(false);
          expect(VALID_CODES.has(leg.account)).toBe(true);
        }
      }
    }
  });

  it('pickScenario only returns entries from the scenario list', () => {
    const rng = mulberry32(77);
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const sc = pickScenario(rng);
      seen.add(sc.description);
      expect(SCENARIOS).toContain(sc);
    }
    // Over 500 samples across 14 scenarios we expect most scenarios to
    // appear at least once — this sanity-checks the weighted selector
    // is not getting stuck on a single branch.
    expect(seen.size).toBeGreaterThan(SCENARIOS.length / 2);
  });
});

describe('generateEntries (integration)', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const end = new Date('2026-12-31T00:00:00Z');

  it('satisfies every engine invariant on a small batch', () => {
    const rng = mulberry32(0xc0ffee);
    const entries = generateEntries(1_000, rng, start, end);
    expect(entries.length).toBeGreaterThan(0);

    let totalRows = 0;
    for (const entry of entries) {
      expect(entry.legs.length).toBeGreaterThanOrEqual(2);
      const { debit, credit } = sumLegs(entry.legs);
      expect(debit).toBe(credit);
      for (const leg of entry.legs) {
        expect(VALID_CODES.has(leg.account)).toBe(true);
        expect(leg.debit > 0 || leg.credit > 0).toBe(true);
        expect(leg.debit > 0 && leg.credit > 0).toBe(false);
      }
      expect(entry.date.getTime()).toBeGreaterThanOrEqual(start.getTime());
      expect(entry.date.getTime()).toBeLessThanOrEqual(end.getTime());
      totalRows += entry.legs.length;
    }
    expect(totalRows).toBeGreaterThanOrEqual(1_000);
  });

  it('is deterministic for a given seed', () => {
    const a = generateEntries(200, mulberry32(555), start, end);
    const b = generateEntries(200, mulberry32(555), start, end);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('produces different output for different seeds', () => {
    const a = generateEntries(50, mulberry32(1), start, end);
    const b = generateEntries(50, mulberry32(2), start, end);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });
});
