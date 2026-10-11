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

## Phase 4 test tiers
| Tier | Command | What it proves |
|---|---|---|
| Mocked unit / integration / component | `npm test` | Counting, follow-up rules and service, retention, activity/visits, quarter heatmap and tooltip metrics, deadlines, charts, views, routes. Uses the in-memory fake Sheets client. |
| Isolated browser E2E | `npm run test:e2e:isolated` | Real browser against the real app on an **in-memory Sheets backend** (`SHEETS_TEST_BACKEND=memory`, refused in production; Google variables forced empty). `workflow.spec.ts` is the per-account audit for Anni, Lukky and Rishii (identity, validation, duplicates, status persistence, My Applications scoping, cross-member isolation, owner-only edit/delete, unauthorized calls, logout, exact counts, follow-up modal, activity). `responsive.spec.ts` runs at 320x568, 375x812, 430x932, 768x1024, 1366x768 and 1920x1080 (overflow, nav, axe, dialogs, tooltip by hover/focus/tap, follow-up modal). Persisted rows are read back through the guarded `/api/test/seed` route. |
| Live Google Sheets | `npm run sheets:test-setup` then `npm run test:live` | Real Google Sheets API against a manually created DISPOSABLE spreadsheet (see "Live Sheets setup" below). Not part of `npm test`. |
| Unverified on production | - | Retention cleanup; follow-up columns on the live sheet (add the `FollowUpAnswer`/`FollowUpAnsweredAt` headers first). |

Elapsed time is simulated by seeding old `AppliedAt` / `AddedAt` timestamps; no test waits seven days.

## Live Sheets setup
Why a manual spreadsheet: the service account can read and write spreadsheets shared with it (verified: `spreadsheets.get` on the production sheet returns 200), but `spreadsheets.create` returns `403 PERMISSION_DENIED "The caller does not have permission"` with no further detail. Creating a file is a different permission from editing a shared one, and widening the service account's IAM is not needed, so the test workflow uses a spreadsheet you create yourself.
1. In Google Sheets (signed in as a project owner), create a **new blank spreadsheet** titled `JobSync TEST (disposable)`. It must be a different file from the production sheet.
2. Click **Share**, add the service-account email (`GOOGLE_SERVICE_ACCOUNT_EMAIL` in `.env.local`, ends with `.iam.gserviceaccount.com`) as **Editor**, untick "Notify", and share.
3. Copy the ID from the URL: `https://docs.google.com/spreadsheets/d/<THIS_PART>/edit`.
4. Create `.env.test.local` (gitignored) in the project root containing one line: `GOOGLE_TEST_SPREADSHEET_ID=<THIS_PART>`. No keys or secrets belong in this file; credentials stay in `.env.local`.
5. `npm run sheets:test-setup` adds the four tabs, the headers (including `FollowUpAnswer`/`FollowUpAnsweredAt`) and the three Members rows to the test spreadsheet only. It exits with an error if the ID is missing (exit 3) or equals the production ID (exit 2), and never creates a spreadsheet.
6. `npm run test:live` runs the live tests. They fail (they do not silently skip) when the test ID is missing or equals the production ID, take a read-only snapshot of the production sheet before and after (the run fails if it changed), mark every record `[LIVE TEST]`, and clear the test sheet afterwards.

### Live retention and the production read-only check
- `npm run test:live` also runs `tests/live/retention.live.test.ts`: real expired/kept/unreadable jobs on the test sheet; dry run deletes nothing, cleanup refuses unless `RETENTION_CLEANUP_ENABLED=true`, then deletes only the expired jobs and their application rows, clears Activity references and leaves everything else (including a job with an unreadable `AddedAt`) untouched.
- `npm run test:prod-readonly` is a **strictly read-only** look at production: every write is blocked by a guard that throws, and a before/after snapshot proves nothing changed. It checks the four tabs and the `Applications!H1:I1` headers, reports each member's due follow-ups, and prints the retention dry run (every proposed deletion). Destructive cleanup on production stays disabled.
- Google allows about 60 reads per minute per user; the live suites pause between tests. If you re-run them back to back and see `rate_limited`, wait a minute.

## Test data
The Sheets tests use `tests/helpers/fake-sheets.ts`, an in-memory stand-in for the Google API with failure injection. Fixtures are clearly synthetic (`Synthetic Co A`, `jobs.example.test`, `Testville`). No credentials are needed; nothing in the normal suite touches Google or any real spreadsheet, and no test data can reach production because the fake is only installed from test files.

## Live integration
The owner verified the live connection with `/api/sheets/status` for Anni, Lukky and Rishii (all four tabs `ok: true`, 0 row issues), and the Phase 3 pages were viewed read-only against the real, empty spreadsheet. A real **write** (adding a job, applying) has not been exercised by the automated work, to avoid creating fake production data; the first real job the owner adds is that check. To test writes yourself, use a disposable copy of the spreadsheet, never production data:
1. Put the `GOOGLE_*` variables in `.env.local` pointing at the disposable sheet.
2. `npm run dev`, sign in, open `/api/sheets/status`; expect every tab `ok: true`.
3. Optionally exercise `POST /api/jobs` and `PUT /api/applications/<jobId>` from the browser console while signed in, then delete the test rows by hand.

## Visual check
The login, All Jobs, Add Job and My Applications screens were compared manually against `assets/login.png`, `all-jobs.png`, `add-jobs.png` and `my-aaplications.png` (populated tables were checked with temporary synthetic rows in a local preview that was deleted afterwards; the real empty states were checked read-only against the live sheet). Automated comparison against all six screens is part of Phase 5.
