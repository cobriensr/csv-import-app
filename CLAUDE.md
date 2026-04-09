# Tax Lot Matching Project

## Development Workflow (Get It Right)

Every code change follows this implement-verify-review loop. No exceptions. This applies to the main session and all subagents that write code.

### The Loop

**1. Implement** — Write the code. Investigate first, understand existing patterns, then make changes.

**2. Verify** — Run `npm run review`. Fix any failures. If it still fails after 2 fix attempts, proceed to step 3 with the failure details.

**3. Self-Review** — Launch a **reviewer subagent** to evaluate the implementation with fresh eyes. The subagent must:

- Run `git diff` to read every changed file
- Evaluate against: correctness, pattern adherence (CLAUDE.md conventions), code quality, test coverage, side effects
- Return a verdict: `pass`, `continue`, or `refactor`
- Write detailed feedback (this is the ONLY bridge to the next iteration if not passing)

**Reviewer subagent verdict meanings:**

- **pass** — Correct and complete. Commit the changes.
- **continue** — Approach is sound but has fixable issues. Apply the feedback, re-run verify, and re-review. Do NOT start over.
- **refactor** — Approach is fundamentally wrong. Launch a **refactor subagent** to undo the problematic work (revert, do NOT reimplement), then restart from step 1 with the reviewer's feedback guiding a fresh approach.

**4. Act** — On `pass`: stage and commit. On `continue` or `refactor`: loop back (max 3 total iterations). After 3 iterations, commit what you have and report honestly what's unresolved.

### When to skip the review subagent

- Single-line config changes, typo fixes, or comment edits
- Changes that only touch `.md` files, `.json` config, or `ml/` Python scripts

Everything else gets the full loop.

## Out of Scope

This is a ~2-hour interview build. The evaluation criteria are correctness, clarity, and working software — not production hardening. Do NOT build any of the following unless the core requirements are fully met with time to spare:

- **No database or persistence layer.** The `POST /api/compute` endpoint is stateless — events come in on the request, results go out on the response. Adding a DB is a trap that eats time and adds nothing the prompt asks for.
- **No authentication or authorization.** Not mentioned in the prompt, not needed.
- **No Docker, containerization, or deployment config.** Runs locally via `npm run dev`.
- **No multi-asset logic beyond a simple asset tag on each event.** Do not build cross-asset swaps, fiat conversion, or asset-pair handling.
- **No tax-domain features beyond the three event types.** No wash sales, no fees, no slippage, no short-term vs long-term classification, no holding-period rules.
- **No decimal/money library.** `number` is acceptable; call out the floating-point limitation in the README and be ready to discuss it.
- **No component library, CSS framework, or heavy styling.** Raw HTML tables and minimal inline styles. The prompt explicitly says the UI does not need to be styled.
- **No state management library, router, or data-fetching library on the frontend.** `useState` + `fetch` is enough for a single page.
- **No tests written after the fact.** Tests are written alongside the engine code that produces them — that is where correctness is proven during the build.
- **No premature abstraction.** No dependency injection frameworks, no plugin architectures, no "ports and adapters". The matching method is a strategy passed as a function; that is the full extent of indirection needed.

When in doubt, ask: _does the prompt explicitly require this?_ If not, skip it and note the decision in the README.

## Key Patterns

### Backend (api/)

**Stack:** TypeScript + Express, running on Node via `tsx` for zero-config dev.

**Shape:** A single `POST /api/compute` endpoint. Stateless — events arrive on the request body, the full computation result is returned on the response. No persistence, no shared process state.

**Validation:** Zod schemas at the HTTP boundary. Parse once on entry, hand typed data to the engine, let everything inside the engine assume valid input.

**Engine:** The core is a pure function `compute(events, method) => { lines, finalInventory, totalRealizedGainLoss }` that lives in its own module (`api/engine/`) with no Express dependency. It can be imported and tested independently of the HTTP layer.

**Matching strategy:** FIFO / LIFO / HIFO are implemented as lot comparator functions passed into the sell handler. The handler itself is agnostic to which method is running — it just pops lots in the order the comparator dictates, splitting the last lot if needed for partial consumption.

**Determinism:** Every sort has a documented secondary tiebreaker (original event index) so results are reproducible across runs and matching methods.

**Error handling:** Fail loud at the boundary. Over-sell, unknown wallet, negative quantity, and asset mismatch all throw — the endpoint returns 400 with a clear message. No silent partial results.

### Frontend (src/)

**Stack:** Vite + React + TypeScript, scaffolded via `npm create vite@latest`.

**Shape:** Single page, no router. Three sections stacked vertically:

1. Event editor — a list of rows where the user can add/edit/remove buys, sells, and transfers
2. Matching method picker — a `<select>` or radio group for FIFO / LIFO / HIFO
3. Results panel — two tables (consumption lines + remaining inventory) and a total realized gain/loss summary

**State:** Plain `useState` in a single top-level component. No Redux, no Zustand, no Context. The event list is the only meaningful state; results are derived by calling `POST /api/compute` on a "Run" button click and storing the response.

**Styling:** Raw HTML tables with minimal inline styles or a tiny global stylesheet. No component library, no Tailwind, no CSS-in-JS. Ugly-but-legible beats time spent on aesthetics.

**Type sharing:** Event and result types live in a shared module (`shared/types.ts` or similar) imported by both the engine and the UI, so the request/response contract cannot drift.

### Testing

**Stack:** Vitest (ships with Vite, no Jest setup friction). Tests live next to the code they cover (`*.test.ts`).

**Where the coverage goes:**

- **Engine unit tests (primary focus)** — one test file per matching method proving correct lot selection and correct realized gain/loss math. Plus dedicated tests for: partial lot consumption, transfer splitting a lot, transfers preserving cost basis and acquisition date, tiebreaker determinism, and the over-sell error path.
- **API integration test** — one test that imports the Express app and hits `POST /api/compute` with a known fixture, asserting the full response shape.
- **No UI tests unless time permits.** React Testing Library adds setup overhead that is not justified for a ~2-hour build. The UI is thin enough to validate manually.

**When tests are written:** Alongside the engine code, not after. Each matching method gets its test before the next method is started. This is where correctness is proven during the build — it is also the thing a reviewer will look at first.

**Fixtures:** Keep a small set of hand-computed scenarios (3–5 events each) as fixtures that are reused across engine and API tests. Having the expected output calculated by hand on paper is worth the five minutes — it catches off-by-one and sign errors immediately.

## Code Style

- **Prettier** — 2-space indent, single quotes, trailing commas, 80 char width.
- **ESLint** — typescript-eslint + react-hooks + react-refresh + sonarjs. Config in `eslint.config.ts`.
- Nested ternaries in JSX are allowed (`sonarjs/no-nested-conditional: off`).
- **SonarJS rules to remember**: use `Number.parseFloat`/`Number.parseInt` (not globals), use `.at(-1)` not `[arr.length - 1]`, no nested template literals (extract to variable).
- Run `npm run lint` before reporting any task complete. Lint covers root project only — `sidecar/` and `playwright-report/` are in the ESLint ignores list.
- Use `type` imports for type-only imports (`import type { ... }`).

## Environment Variables
