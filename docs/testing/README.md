# Testing

| Suite | Command | Covers |
|---|---|---|
| Unit | `npm test` | Phase 1: access codes, sessions, rate limiter, nav/member config. Phase 2: URL normalisation, date/timezone helpers, job and application schemas, status transitions, row parsers (valid, malformed, partially valid), header checks, config validation, Google error mapping, retry/backoff |
| Integration | `npm test` | Phase 1: login/logout routes. Phase 2 services against an in-memory fake Sheets client: job creation, IDs/timestamps, duplicate URLs (including simultaneous requests), malformed and hand-edited rows, per-member application independence and isolation, transitions, idempotency, activity logging, Members-tab activation, wrong headers/missing tabs, Google 401/403/404/429/5xx handling, status check. Route handlers with a mocked session: 401 without session, identity from session only, strict bodies, 400/404/409/413, error responses free of secrets, 503 when unconfigured |
| Component | `npm test` (jsdom) | Phase 3 UI with mocked `fetch`: All Jobs (counts, empty state, search, every filter, Reset, sorting, pagination, status toggle success/failure/network error, locked later stages, row menu, details dialog), Add Job (required/format validation, blur validation, Clear, exact request body with no identity fields, success, duplicate link, server field errors, network error), My Applications (columns, empty state, filters, update dialog limited to allowed transitions, save payload, undo removes row, error handling) |
| End-to-end | `npm run test:e2e` | Desktop and mobile (Pixel 7): all Phase 1 flows; data routes 401 unauthenticated; safe 503 when Google is not configured; spoofed `memberId` never accepted; Phase 3 pages show a safe error state (never sample data) and redirect without a session; global search and Ctrl+K; sidebar navigation; each member's accent theme and axe accessibility on the data pages |
| Static | `npm run lint`, `npm run typecheck`, `npm run build` | Lint, types, production build |

One-time: `npx playwright install chromium`. E2E tests start their own dev server on port 3100 with its own build folder (`.next-e2e`), so they can run while a normal `npm run dev` is open.

**E2E never touches the real spreadsheet.** `playwright.config.ts` starts the server with the three `GOOGLE_*` variables forced empty (empty values cannot be overridden by `.env.local`), so Google Sheets is unconfigured and the data routes and pages return their safe error state. Data behaviour is tested with the fake Sheets client and mocked `fetch` instead.

## Test data
The Sheets tests use `tests/helpers/fake-sheets.ts`, an in-memory stand-in for the Google API with failure injection. Fixtures are clearly synthetic (`Synthetic Co A`, `jobs.example.test`, `Testville`). No credentials are needed; nothing in the normal suite touches Google or any real spreadsheet, and no test data can reach production because the fake is only installed from test files.

## Live integration
The owner verified the live connection with `/api/sheets/status` for Anni, Lukky and Rishii (all four tabs `ok: true`, 0 row issues), and the Phase 3 pages were viewed read-only against the real, empty spreadsheet. A real **write** (adding a job, applying) has not been exercised by the automated work, to avoid creating fake production data; the first real job the owner adds is that check. To test writes yourself, use a disposable copy of the spreadsheet, never production data:
1. Put the `GOOGLE_*` variables in `.env.local` pointing at the disposable sheet.
2. `npm run dev`, sign in, open `/api/sheets/status`; expect every tab `ok: true`.
3. Optionally exercise `POST /api/jobs` and `PUT /api/applications/<jobId>` from the browser console while signed in, then delete the test rows by hand.

## Visual check
The login, All Jobs, Add Job and My Applications screens were compared manually against `assets/login.png`, `all-jobs.png`, `add-jobs.png` and `my-aaplications.png` (populated tables were checked with temporary synthetic rows in a local preview that was deleted afterwards; the real empty states were checked read-only against the live sheet). Automated comparison against all six screens is part of Phase 5.
