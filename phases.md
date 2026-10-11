# JobSync — Master Roadmap

## Status
| Phase | Status |
|---|---|
| 1 — Foundation and secure login | Complete (commit `8c8bc38`) |
| 2 — Google Sheets integration | Complete; live Google connection verified by the owner for Anni, Lukky and Rishii (`/api/sheets/status`) |
| 3 — Job management | Implemented and tested (mocked Sheets and component tests); read-only look at the real empty states done; awaiting owner approval |
| 4 — Dashboard and analytics | Not started |
| 5 — Final testing and deployment | Not started |

Five phases, executed strictly one at a time. This file is the authority for scope.

## Mandatory workflow (every phase)

1. Read this file before starting.
2. Implement every requirement of the phase and nothing from later phases.
3. Run lint, type checks, and tests; do not claim a check passed unless it actually ran.
4. Update documentation.
5. Commit and push as `Aniket Raj <aniketraj00384@gmail.com>`; no AI attribution anywhere. Never force-push.
6. Report the commit hash and actual test results.
7. **Stop and wait for the owner's explicit approval** before the next phase.

## Global rules

- Reference screenshots in `assets/` are the visual source of truth: `login.png`, `dashboard.png`, `all-jobs.png`, `add-jobs.png`, `my-aaplications.png` (sic — filename as it exists; do not rename the original), `analytics.png`. Profile photos: `anni.jpeg`, `lukky.jpeg`, `rishii.jpeg` (served from `public/assets/`).
- Screenshots are never used as backgrounds or as static mockups; every screen is a real interface.
- Every visible button, tab, filter, form, nav item, status control and chart interaction must work. No dead or decorative controls, no fake data presented as real.
- Identity and data rules (owner-confirmed): jobs are shared by all three members; application status is independent per member (Anni marking Applied never changes Lukky or Rishii); name, photo, welcome message, theme, statistics, progress and analytics always belong to the authenticated member; the server derives the member from the validated session, never from browser-supplied names, IDs or URLs; the dashboard may show team contributions without mixing personal statistics; no hardcoded names, fake statistics or placeholder application data presented as real.
- Reference images are UI design references only. They are never rendered as page content, and no job, company, salary, status or statistic visible in them is ever copied, seeded or presented as data. Nothing seeds Google Sheets. All data comes from records users enter and persist in Sheets; an empty database shows a designed empty state with a clear "add the first job" action. Automated tests may use clearly labelled synthetic fixtures in isolated test environments only.
- Locked stack: Next.js App Router, React, TypeScript, Tailwind CSS, route handlers, Google Sheets as the only persistent store, Vercel. No Supabase, PostgreSQL, Prisma or other databases.
- All Google Sheets access is server-side. Secrets never reach browser code or Git.
- Navigation is exactly: Dashboard, All Jobs, Add Job, My Applications, Analytics. No Team Activity or Bookmarks.

---

## Phase 1 — Project Foundation and Secure Login

**Objectives:** a working Next.js foundation, the design system, and secure per-member authentication.

**Scope**
- Create/adapt the Next.js (App Router, TypeScript, Tailwind) project; none exists yet at preparation time.
- Global styles, design tokens, dark navy theme with electric-blue accents; per-member accent (Anni blue, Lukky yellow, Rishii red).
- Organize reference assets and profile photos without losing originals.
- Screenshot-matched login page: three profile cards (Anni, Lukky, Rishii); clicking one reveals that member's access-code panel; Back returns to selection.
- Server-side code validation preserving leading zeros (codes are strings). Prototype mapping: Anni `0001`, Lukky `0002`, Rishii `0003` — prototype secrets, server-side only, never in client bundles, to be rotated/replaced with managed secrets before production (documented).
- HTTP-only, secure, SameSite session cookies; signed sessions; expiry; logout; server-side authorization for pages and routes; rate limiting on login.
- Shared authenticated layout and sidebar with exactly the five navigation items.
- Baseline tests, responsive and accessibility checks.

**Deliverables:** running app with login/logout, protected layout, placeholder-free nav targets (routes for the other screens may render only a minimal authenticated shell, clearly not mock data), tests, docs, README commands verified.

**Dependencies:** none.

**Validation:** wrong/right codes per member; leading zeros kept; cookie flags; expired session rejected; unauthenticated access redirected; rate limit triggers; keyboard and screen-reader basics; mobile and desktop layouts; login compared against `login.png`.

**Completion criteria:** all scope implemented; lint, type-check, tests and build actually run and pass; docs updated; committed and pushed; hash reported. **Stop for approval before Phase 2.**

---

## Phase 2 — Google Sheets Integration

**Objectives:** a reliable, typed, server-only data layer on a private spreadsheet.

**Scope**
- Server-side Google Sheets API access via service account.
- Document creating a private spreadsheet named `JobSync Database` and sharing it with the service account only.
- Four tabs and columns:
  - `Jobs`: `JobID`, `Company`, `JobRole`, `JobType`, `WorkMode`, `Experience`, `StipendSalary`, `Location`, `JobURL`, `Deadline`, `Description`, `AddedBy`, `AddedAt`
  - `Applications`: `JobID`, `MemberID`, `Status`, `AppliedAt`, `ApplicationStage`, `Notes`, `LastUpdated`
  - `Members`: `MemberID`, `Name`, `Photo`, `Active`
  - `Activity`: `ActivityID`, `MemberID`, `Date`, `Action`, `JobID`, `Timestamp`
- Typed data-access services; input and row validation; stable IDs and timestamps; duplicate job URL detection.
- Handling of malformed rows, API failures, rate limits (backoff) and concurrent writes.
- Member-specific application authorization; independent per-member statuses.
- No service-account credentials in Sheets; no secret hashes in public APIs.

**Deliverables:** `src/lib/google-sheets/` services, types, validation schemas, setup doc in `docs/setup/`, tests with a mocked Sheets client.

**Dependencies:** Phase 1 approved (session identity).

**Validation:** unit/integration tests for reads, writes, duplicates, malformed rows, error mapping, authorization and status independence; a manual check against a real test spreadsheet when the owner provides one.

**Phase 2 outcome (implemented):** typed server-only data layer in `src/lib/google-sheets/`; four-tab schema with header verification; job/application/activity/member services; strict validation; URL normalisation and duplicate detection; per-member application isolation with a documented status model and transitions; protected routes `GET/POST /api/jobs`, `GET /api/applications`, `PUT /api/applications/[jobId]`, `GET /api/sheets/status`; Google error mapping, timeouts and retry; setup, testing and architecture docs. Verified by automated tests with a mocked Sheets client. **Not verified:** any live Google spreadsheet (no credentials were available); granting of the owner/editor sharing permissions (documented only). **Known limitations:** no cross-instance locking (see architecture.md "Concurrency"); no delete endpoints; reading re-fetches whole tabs, which is fine at this scale.

**Completion criteria:** all scope implemented and tested; docs updated; committed and pushed. **Stop for approval before Phase 3.**

---

## Phase 3 — Job Management

**All Jobs:** shared list, search, filters, pagination; details, external link, deadline, salary/stipend, type, location, experience; a single personal status indicator (green tick = Applied, red cross = Not Applied) — no per-member status columns; changes persisted via server routes to Sheets.

**Add Job:** company, title, URL, location, job type, experience, internship/full-time classification, salary/stipend, deadline, optional description/requirements; working validate/clear/submit; duplicate URL detection; contributor and timestamp recorded; new jobs appear in All Jobs from persisted data.

**My Applications:** only the logged-in member's applications; search, filters, appropriate actions; columns for company, role, location, type, experience, salary/stipend, status, applied date, deadline; no charts; no other member's details exposed.

**Deliverables:** three screens, route handlers, components, tests. **Dependencies:** Phases 1–2 approved.

**Validation:** screens compared to `all-jobs.png`, `add-jobs.png`, `my-aaplications.png`; every control exercised; member isolation tests; duplicate handling.

**Phase 3 outcome (implemented):** All Jobs (summary cards, search, five filters, Reset, sorting, pagination, details dialog, Applied/Not Applied toggle, external links, row actions), Add Job (validated form, Clear, duplicate-link handling, Recently Added panel from real data), My Applications (own applications only, search, filters, sorting, pagination, update dialog with allowed transitions only, details; no charts), a working top-bar search with Ctrl/Cmd+K, per-member accent theming of primary controls, and designed empty/error states. Data comes only from Google Sheets via the Phase 2 services; identity only from the session. **Verified:** lint, type check, unit/integration/component tests, production build, Playwright e2e (isolated from the real sheet), and a read-only look at the real empty states. **Not verified:** writing a real job to the live spreadsheet (deliberately not done, to avoid fake production data); the first real job the owner adds is the live write check. **Known limitations:** see architecture.md "Limitations (Phase 3)".

**Completion criteria:** all implemented, tested, documented, committed, pushed. **Stop for approval before Phase 4.**

---

## Phase 4 — Dashboard and Analytics

**Dashboard (match `dashboard.png`):** personalized welcome and profile photo; shared job count; personal applications; personal pending/in-progress; team member count; daily target of 10 jobs per member; team contribution summary/chart; recent jobs; upcoming deadlines; useful quick actions. Every metric derives from real data.

**Analytics (match `analytics.png`):** personal-only data; animated donut chart, trend graph, response rate, job-type distribution, companies, locations, experience levels, activity timeline, deadlines where appropriate; real calculations; meaningful empty states; no hardcoded demo statistics; no other member's personal application data.

**Deliverables:** both screens, calculation utilities with unit tests, charts. **Dependencies:** Phases 1–3 approved.

**Validation:** calculation tests with fixtures including empty data; compare to screenshots; chart interactions work.

**Phase 4 outcome (implemented):** Dashboard and Analytics from real Sheets data, personalised per member (team contribution shared, personal numbers private; daily target = jobs the member added today in the app timezone); one counting module for every number; Application Timeline heatmap for the current calendar quarter (rolls over automatically) with a per-day tooltip (Job Added, Job Applied, work streak); real Deadlines Overview; job edit/delete (owner only, enforced on the server); near-real-time refresh (polling); the blocking 7-day (168 h) follow-up question with four answers; 30-day retention (dry run by default, cleanup disabled until approved); activity events (login, deduplicated visits, work); fully responsive layouts (tables become cards below 1280 px). **Verified:** lint, type check, unit/integration/component tests, production build, desktop + mobile Playwright suites on an isolated in-memory backend (per-account workflow audit; responsive suite at 320x568, 375x812, 430x932, 768x1024, 1366x768, 1920x1080). **Not verified:** automated tests against a real, disposable Google spreadsheet (none was available: the service account cannot create spreadsheets); retention cleanup against production (deliberately disabled).

**Completion criteria:** all implemented, tested, documented, committed, pushed. **Stop for approval before Phase 5.**

---

## Phase 5 — Final Testing and Deployment

**Scope**
- Compare all six screens to their reference images.
- Exercise every button, nav item, filter, form, status control and chart interaction.
- Test authentication, session expiry, logout, member isolation, rate limiting, validation, duplicates, unauthorized requests.
- Test malformed rows, empty data, API errors, concurrent writes.
- Run lint, TypeScript checks, unit/integration tests, production build; add end-to-end tests where practical.
- Verify desktop/mobile responsiveness and accessibility.
- Audit repository history and env files for exposed credentials.
- Document Vercel environment variables, service-account configuration, spreadsheet permissions, deployment and smoke tests.
- Deploy only after validation and approval of previous phases.
- Complete documentation and deployment checklist.

**Dependencies:** Phases 1–4 approved.

**Completion criteria:** all checks run and reported honestly; deployment verified by smoke tests; documentation complete; committed and pushed.

**Phase 5 outcome (deployed):** production runs at **https://jobsbyarillabs.vercel.app** on Vercel (project `jobsbyarillabs`, repo `iamankoo/JobSync`, branch `main`). `jobsync.vercel.app` was tried first and Vercel refused it (already in use). Verified on the live URL: HTTPS, all three logins, logout/unauthorised access, member identity enforcement, all five pages, all 7 shared jobs, mobile/tablet/desktop layouts, and no secrets in the browser bundles. Production retention cleanup remains disabled. **Not verified:** a real production follow-up answer. Details, environment variable names, rollback and limitations: `docs/deployment/README.md`.
