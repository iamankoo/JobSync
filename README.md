# JobSync

A private job-tracking web app shared by three members: **Anni** (blue), **Lukky** (yellow) and **Rishii** (red).
Screens: Login, Dashboard, All Jobs, Add Job, My Applications, Analytics.

**Status:** Phases 1 (secure login), 2 (Google Sheets data layer) and 3 (All Jobs, Add Job, My Applications) are implemented, and the live Google connection is verified for all three members. Phase 4 (Dashboard, Analytics, 7-day follow-up, job edit/delete, 30-day retention) is implemented and awaiting approval; Phase 5 has not started. Work proceeds one phase at a time with explicit owner approval.

## Documents
- [phases.md](phases.md) – five-phase roadmap and completion criteria
- [architecture.md](architecture.md) – architecture, data flow, security boundaries
- [techstack.md](techstack.md) – technologies and verified commands
- [docs/setup](docs/setup/README.md), [docs/testing](docs/testing/README.md), [docs/deployment](docs/deployment/README.md)

## Quick start
```bash
npm install
cp .env.example .env.local   # add GOOGLE_* values for data routes; see docs/setup/README.md
npm run dev                  # http://localhost:3000
```
Without env vars, development uses documented prototype access codes and a dev-only session secret. Production refuses to start sessions without `SESSION_SECRET` and fails closed without access codes.

## Commands
`npm run dev`, `npm run build`, `npm start`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e`, `npm run test:e2e:isolated` (browser workflow + responsive suites on an in-memory backend), `npm run sheets:test-setup` (prepare a disposable test spreadsheet).

## Layout
- `assets/` – original reference screenshots and photos (never modified)
- `public/assets/` – browser-served copies of the profile photos
- `src/app` – pages and route handlers; `src/components`; `src/lib` (`auth`, `validation`); `src/config`
- `tests/` – `unit`, `integration`, `e2e`

## Screens
- **All Jobs**: shared jobs with search, filters, sorting, pagination, details and your own Applied/Not Applied status.
- **Add Job**: validated form; duplicate links are detected; new jobs appear for everyone.
- **My Applications**: your own applications only, with status/stage/notes updates.

All data comes from the Google spreadsheet; an empty sheet shows an empty state with an **Add New Job** button, never sample data.

## Data API (all routes need a signed-in session)
`GET/POST /api/jobs`, `GET /api/applications`, `PUT /api/applications/[jobId]`, `GET /api/sheets/status`. Jobs are shared; each member has an independent application status. Identity always comes from the session. Without Google configuration these routes return a safe 503; there is no sample data. Details: `architecture.md`.

## Security notes
Access codes are verified on the server only. Sessions are signed, HTTP-only cookies; identity is always taken from the validated session, never from browser-supplied names or IDs. Never commit `.env*` files or service-account JSON.
