/**
 * Generates the demo CSV fixtures in `data/` at a scale that exercises the
 * engine as a streaming-ready pipeline (~250k rows per file).
 *
 * The output is fully deterministic: each file is driven by a seeded PRNG
 * (mulberry32), so regenerating produces byte-identical content and any diff
 * is signal, not noise.
 *
 * Run: `npx tsx scripts/generate-sample-data.ts` (or `npm run gen:sample-data`).
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', 'data');

const TARGET_ROWS_CLEAN = 250_000;
const TARGET_ROWS_ERRORS = 250_000;
const SEED_CLEAN = 0x1337beef;
const SEED_ERRORS = 0xdeadbeef;

const HEADER = 'date,reference,account_code,debit,credit,description,memo';

const MS_PER_DAY = 86_400_000;

// --- PRNG ------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function randomInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function pickFrom<T>(rng: () => number, arr: readonly T[]): T {
  const value = arr[Math.floor(rng() * arr.length)];
  if (value === undefined) {
    throw new Error('pickFrom called on empty array');
  }
  return value;
}

// --- Domain model ----------------------------------------------------------

export type Leg = { account: string; debit: number; credit: number };

export type Entry = {
  date: Date;
  legs: Leg[];
  description: string;
  memo: string;
};

export type Scenario = {
  description: string;
  memos: readonly string[];
  weight: number;
  generate: (rng: () => number) => Leg[];
};

/**
 * Factory for the common "debit one account, credit another for the same
 * amount" shape. Eliminates the per-scenario boilerplate that would otherwise
 * trip the sonarjs identical-function rule.
 */
export function twoLeg(
  description: string,
  memos: readonly string[],
  weight: number,
  debitAcct: string,
  creditAcct: string,
  minCents: number,
  maxCents: number,
): Scenario {
  return {
    description,
    memos,
    weight,
    generate: (rng) => {
      const amount = randomInt(rng, minCents, maxCents);
      return [
        { account: debitAcct, debit: amount, credit: 0 },
        { account: creditAcct, debit: 0, credit: amount },
      ];
    },
  };
}

export const SCENARIOS: readonly Scenario[] = [
  twoLeg(
    'Monthly office rent',
    ['Landlord ACH', 'Building mgmt payment', 'Rent wire'],
    5,
    '5200',
    '1010',
    150_000,
    500_000,
  ),
  twoLeg(
    'Office supplies',
    ['Staples order', 'Amazon business', 'Costco office run'],
    7,
    '5100',
    '1010',
    2_000,
    80_000,
  ),
  twoLeg(
    'Consulting services invoiced',
    ['Client monthly retainer', 'Project billing', 'Advisory work'],
    10,
    '1200',
    '4020',
    50_000,
    1_500_000,
  ),
  twoLeg(
    'Sales invoice issued',
    ['Wholesale order', 'B2B invoice'],
    6,
    '1200',
    '4010',
    25_000,
    800_000,
  ),
  twoLeg(
    'Vendor payment',
    ['Check issued', 'ACH to vendor', 'Wire transfer'],
    8,
    '2010',
    '1010',
    5_000,
    500_000,
  ),
  twoLeg(
    'Utilities accrued',
    ['Electric bill', 'Water bill', 'Gas bill', 'Internet service'],
    4,
    '5300',
    '2010',
    7_500,
    120_000,
  ),
  twoLeg(
    'Utilities paid',
    ['Auto-pay utility', 'Direct debit utility'],
    3,
    '5300',
    '1010',
    7_500,
    120_000,
  ),
  twoLeg(
    'Equipment purchase financed',
    ['Server hardware', 'Fleet vehicle', 'New laptops', 'Office furniture'],
    2,
    '1700',
    '2500',
    500_000,
    5_000_000,
  ),
  twoLeg(
    'Owner capital contribution',
    ['Owner investment', 'Capital infusion'],
    1,
    '1010',
    '3010',
    500_000,
    10_000_000,
  ),
  twoLeg(
    'Loan principal payment',
    ['Monthly loan servicing', 'LT debt payment'],
    3,
    '2500',
    '1010',
    20_000,
    300_000,
  ),
  twoLeg(
    'Customer payment received',
    ['AR collection', 'Invoice paid', 'Customer ACH'],
    10,
    '1010',
    '1200',
    10_000,
    1_500_000,
  ),
  twoLeg(
    'Inventory purchase on account',
    ['PO received', 'Vendor shipment', 'Restock order'],
    8,
    '1500',
    '2010',
    20_000,
    1_000_000,
  ),
  // Payroll — 3 legs (gross = net + withholding credited to accrued liab).
  {
    description: 'Biweekly payroll run',
    memos: ['Pay period batch', 'Payroll ACH run', 'Bi-weekly wages'],
    weight: 6,
    generate: (rng) => {
      const gross = randomInt(rng, 300_000, 2_500_000);
      const withheld = Math.round(gross * 0.22);
      const net = gross - withheld;
      return [
        { account: '5400', debit: gross, credit: 0 },
        { account: '1010', debit: 0, credit: net },
        { account: '2100', debit: 0, credit: withheld },
      ];
    },
  },
  // Cash sale with COGS — 4 legs (sale recognized + inventory relieved).
  {
    description: 'Cash sale with COGS',
    memos: ['Retail counter', 'POS sale', 'Walk-in transaction'],
    weight: 12,
    generate: (rng) => {
      const sale = randomInt(rng, 5_000, 300_000);
      const cogs = Math.round(sale * (0.5 + rng() * 0.2));
      return [
        { account: '1010', debit: sale, credit: 0 },
        { account: '4010', debit: 0, credit: sale },
        { account: '5010', debit: cogs, credit: 0 },
        { account: '1500', debit: 0, credit: cogs },
      ];
    },
  },
];

const TOTAL_WEIGHT = SCENARIOS.reduce((sum, sc) => sum + sc.weight, 0);

export function pickScenario(rng: () => number): Scenario {
  const target = rng() * TOTAL_WEIGHT;
  let acc = 0;
  for (const sc of SCENARIOS) {
    acc += sc.weight;
    if (target < acc) return sc;
  }
  throw new Error('pickScenario: unreachable');
}

// --- Formatting ------------------------------------------------------------

export function addThousandsSeparators(intPart: string): string {
  if (intPart.length <= 3) return intPart;
  const groups: string[] = [];
  let remaining = intPart;
  while (remaining.length > 3) {
    groups.unshift(remaining.slice(-3));
    remaining = remaining.slice(0, -3);
  }
  groups.unshift(remaining);
  return groups.join(',');
}

/**
 * Randomly picks one of four amount presentations so the import pipeline
 * exercises its normalizer over plain, $-prefixed, comma-separated, and
 * both-flavors values in roughly the proportions a real ledger would have.
 */
export function formatAmount(cents: number, rng: () => number): string {
  const dollars = (cents / 100).toFixed(2);
  const dotIdx = dollars.indexOf('.');
  const intPart = dollars.slice(0, dotIdx);
  const decPart = dollars.slice(dotIdx + 1);
  const withCommas = addThousandsSeparators(intPart);
  const r = rng();
  if (r < 0.4) return `${intPart}.${decPart}`;
  if (r < 0.7) return `$${withCommas}.${decPart}`;
  if (r < 0.85) return `${withCommas}.${decPart}`;
  return `$${withCommas}.${decPart}`;
}

function formatDate(date: Date, rng: () => number): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return rng() < 0.65 ? `${y}-${m}-${d}` : `${m}/${d}/${y}`;
}

export function csvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

export function csvRow(fields: readonly string[]): string {
  return fields.map(csvField).join(',');
}

// --- Generation ------------------------------------------------------------

export function generateEntries(
  targetRows: number,
  rng: () => number,
  startDate: Date,
  endDate: Date,
): Entry[] {
  const dayRange = Math.floor(
    (endDate.getTime() - startDate.getTime()) / MS_PER_DAY,
  );
  const entries: Entry[] = [];
  let rowCount = 0;
  while (rowCount < targetRows) {
    const scenario = pickScenario(rng);
    const legs = scenario.generate(rng);
    const date = new Date(
      startDate.getTime() + randomInt(rng, 0, dayRange) * MS_PER_DAY,
    );
    entries.push({
      date,
      legs,
      description: scenario.description,
      memo: pickFrom(rng, scenario.memos),
    });
    rowCount += legs.length;
  }
  return entries;
}

function emitRows(
  entries: Entry[],
  refStart: number,
  rng: () => number,
): string[] {
  // Sort chronologically so the file reads like an actual journal;
  // reference ids are then assigned in post-sort order.
  entries.sort((a, b) => a.date.getTime() - b.date.getTime());
  const rows: string[] = [];
  entries.forEach((entry, i) => {
    const ref = `JE-${refStart + i}`;
    const dateStr = formatDate(entry.date, rng);
    for (const leg of entry.legs) {
      rows.push(
        csvRow([
          dateStr,
          ref,
          leg.account,
          leg.debit > 0 ? formatAmount(leg.debit, rng) : '',
          leg.credit > 0 ? formatAmount(leg.credit, rng) : '',
          entry.description,
          entry.memo,
        ]),
      );
    }
  });
  return rows;
}

function writeClean(): void {
  const rng = mulberry32(SEED_CLEAN);
  const entries = generateEntries(
    TARGET_ROWS_CLEAN,
    rng,
    new Date('2026-01-01T00:00:00Z'),
    new Date('2026-12-31T00:00:00Z'),
  );
  const rows = emitRows(entries, 10_001, rng);
  const content = [HEADER, ...rows].join('\n') + '\n';
  writeFileSync(join(DATA_DIR, 'sample-ledger-clean.csv'), content);
  console.log(
    `sample-ledger-clean.csv: ${entries.length.toLocaleString()} entries, ${rows.length.toLocaleString()} rows`,
  );
}

/**
 * Original error-demonstrating rows preserved verbatim so every error code in
 * the catalog still fires after regeneration. Only the bulk clean rows scale;
 * this 21-row preamble stays stable.
 */
const ORIGINAL_ERROR_ROWS: readonly string[] = [
  '2026-02-02,JE-2001,5200,1800.00,,February rent,Landlord ACH',
  '2026-02-02,JE-2001,1010,,1800.00,February rent,Landlord ACH',
  '2026-02-04,JE-2002,1200,3200.00,,Consulting fees,Invoice 2026-021',
  '2026-02-04,JE-2002,4020,,3200.00,Consulting fees,Invoice 2026-021',
  'not-a-date,JE-ERR-1,5100,125.00,,Bad date row,Should fail ERR_INVALID_DATE',
  'not-a-date,JE-ERR-1,1010,,125.00,Bad date row,Should fail ERR_INVALID_DATE',
  '2026-02-06,JE-ERR-2,5300,xyz,,Bad amount row,Should fail ERR_INVALID_AMOUNT',
  '2026-02-06,JE-ERR-2,1010,,250.00,Bad amount row,Should fail ERR_INVALID_AMOUNT',
  '2026-02-07,JE-ERR-3,5100,500.00,500.00,Both debit and credit populated,Should fail ERR_BOTH_DEBIT_AND_CREDIT',
  '2026-02-07,JE-ERR-3,1010,,500.00,Offsetting leg,Needed for grouping',
  '2026-02-08,JE-ERR-4,5100,,,Neither debit nor credit,Should fail ERR_NEITHER_DEBIT_NOR_CREDIT',
  '2026-02-08,JE-ERR-4,1010,,300.00,Offsetting leg,Needed for grouping',
  '2026-02-09,,5100,225.00,,Missing reference field,Should fail ERR_MISSING_REQUIRED_FIELD',
  '2026-02-09,,1010,,225.00,Missing reference field,Should fail ERR_MISSING_REQUIRED_FIELD',
  '2026-02-10,JE-ERR-6,9999,410.00,,Unknown account code,Should fail ERR_UNKNOWN_ACCOUNT',
  '2026-02-10,JE-ERR-6,1010,,410.00,Unknown account code offset,Should fail ERR_UNKNOWN_ACCOUNT',
  '2026-02-11,JE-ERR-7,5100,(250.00),,Negative amount via accounting parens,Should fail ERR_NEGATIVE_AMOUNT',
  '2026-02-11,JE-ERR-7,1010,,250.00,Offsetting leg,Clean leg',
  '2026-02-12,JE-ERR-8,5200,250.00,,Unbalanced entry leg 1,Should fail ERR_UNBALANCED_ENTRY',
  '2026-02-12,JE-ERR-8,1010,,200.00,Unbalanced entry leg 2,Debits 250 vs credits 200',
  '2026-02-13,JE-ERR-9,5100,175.00,,Single leg entry,Should fail ERR_SINGLE_LEG_ENTRY',
];

function writeErrors(): void {
  const rng = mulberry32(SEED_ERRORS);
  const entries = generateEntries(
    TARGET_ROWS_ERRORS,
    rng,
    new Date('2026-03-01T00:00:00Z'),
    new Date('2026-12-31T00:00:00Z'),
  );
  // Start ref numbering above the original JE-2001/2002 and JE-ERR-* space.
  const rows = emitRows(entries, 3_001, rng);
  const content = [HEADER, ...ORIGINAL_ERROR_ROWS, ...rows].join('\n') + '\n';
  writeFileSync(join(DATA_DIR, 'sample-ledger-with-errors.csv'), content);
  console.log(
    `sample-ledger-with-errors.csv: ${ORIGINAL_ERROR_ROWS.length} error-demo rows + ${entries.length.toLocaleString()} clean entries (${rows.length.toLocaleString()} bulk rows)`,
  );
}

// Only execute the file-writing side effects when this module is invoked
// as the entry point (e.g. `npm run gen:sample-data`). When Vitest imports
// exported helpers for testing, `process.argv[1]` points at the Vitest
// binary, not this file, so the guard keeps tests from clobbering the
// real CSV fixtures.
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  writeClean();
  writeErrors();
}
