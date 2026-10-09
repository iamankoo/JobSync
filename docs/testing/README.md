# Testing

| Suite | Command | Covers |
|---|---|---|
| Unit | `npm test` | Phase 1: access codes, sessions, rate limiter, nav/member config. Phase 2: URL normalisation, date/timezone helpers, job and application schemas, status transitions, row parsers (valid, malformed, partially valid), header checks, config validation, Google error mapping, retry/backoff |
| Integration | `npm test` | Phase 1: login/logout routes. Phase 2 services against an in-memory fake Sheets client: job creation, IDs/timestamps, duplicate URLs (including simultaneous requests), malformed and hand-edited rows, per-member application independence and isolation, transitions, idempotency, activity logging, Members-tab activation, wrong headers/missing tabs, Google 401/403/404/429/5xx handling, status check. Route handlers with a mocked session: 401 without session, identity from session only, strict bodies, 400/404/409/413, error responses free of secrets, 503 when unconfigured |
| End-to-end | `npm run test:e2e` | Desktop and mobile (Pixel 7): all Phase 1 flows, plus data routes returning 401 unauthenticated, a safe 503 (never fake data) when Google is not configured, and a spoofed `memberId` never accepted |
| Static | `npm run lint`, `npm run typecheck`, `npm run build` | Lint, types, production build |

One-time: `npx playwright install chromium`. E2E tests start their own dev server on port 3100.

## Test data
The Sheets tests use `tests/helpers/fake-sheets.ts`, an in-memory stand-in for the Google API with failure injection. Fixtures are clearly synthetic (`Synthetic Co A`, `jobs.example.test`, `Testville`). No credentials are needed; nothing in the normal suite touches Google or any real spreadsheet, and no test data can reach production because the fake is only installed from test files.

## Live integration (not run)
No spreadsheet or credentials were available when Phase 2 was built, so the real Google API calls, permissions and quotas are **unverified**. Once the setup in `docs/setup/README.md` is done, verify with a disposable copy of the spreadsheet (never production data):
1. Put the `GOOGLE_*` variables in `.env.local` pointing at the disposable sheet.
2. `npm run dev`, sign in, open `/api/sheets/status`; expect every tab `ok: true`.
3. Optionally exercise `POST /api/jobs` and `PUT /api/applications/<jobId>` from the browser console while signed in, then delete the test rows by hand.

## Visual check
The login screen was compared manually against `assets/login.png`. Automated comparison against all six screens is part of Phase 5.
