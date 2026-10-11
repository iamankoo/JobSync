# Setup

## Local development
1. `npm install`
2. Copy `.env.example` to `.env.local` and set values (never commit it).
3. `npm run dev`

## Environment variables
| Variable | Purpose |
|---|---|
| `SESSION_SECRET` | Signs session cookies. Required (>= 32 chars) in production; a dev-only fallback is used otherwise. |
| `SESSION_MAX_AGE_SECONDS` | Session lifetime; default 28800 (8 hours). |
| `ACCESS_CODE_ANNI`, `ACCESS_CODE_LUKKY`, `ACCESS_CODE_RISHII` | Per-member access codes, compared as strings (leading zeros kept). |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | ID of the `JobSync Database` spreadsheet. |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | The service account's `client_email`. |
| `GOOGLE_PRIVATE_KEY` | The service account's `private_key` (PEM). `\n` escapes and surrounding quotes are accepted. |
| `APP_TIMEZONE` | IANA timezone for `Activity.Date`; default `Asia/Kolkata`. |

All are server-only. Without the three `GOOGLE_*` variables the data routes return a 503 naming the missing variables; the app never substitutes sample data.

## Prototype access codes
Outside production, if an `ACCESS_CODE_*` variable is unset, the server falls back to the prototype codes (Anni `0001`, Lukky `0002`, Rishii `0003`). They exist only in server code, are never sent to the browser, and are disabled in production. **Rotate or replace them with managed secrets before production** by setting the three env vars.

## Google Sheets setup

> Status: these steps are documented but have **not** been performed or verified against a live spreadsheet from this repository. Live verification is listed under "Verify the connection".

### 1. Google Cloud project
Open https://console.cloud.google.com, create a project (e.g. `jobsync`) or pick an existing one.

### 2. Enable the Google Sheets API
APIs & Services -> Library -> "Google Sheets API" -> Enable. (The Drive API is not needed.)

### 3. Create a service account
IAM & Admin -> Service Accounts -> Create. No project-level roles are required. Then open it -> Keys -> Add key -> Create new key -> JSON. Download the file once and keep it outside the repository. Never commit it (`.gitignore` excludes `*service-account*.json` and `*credentials*.json`, but do not rely on that alone).

### 4. Store the credentials
From the JSON file, copy:
- `client_email` -> `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `private_key` -> `GOOGLE_PRIVATE_KEY` (the whole value including `-----BEGIN PRIVATE KEY-----`; keep it in double quotes with `\n` for line breaks, exactly as in the JSON)

Local: put them in `.env.local`. Vercel: Project -> Settings -> Environment Variables -> add the same names for Production (and Preview if needed). Paste the key as-is; do not mark anything as public. Delete the downloaded JSON when finished, or store it in a password manager.

### 5. Create the private spreadsheet
Create a new Google Sheet named exactly `JobSync Database` from the owner account. Keep it private ("Restricted"); do not enable link sharing. Copy the ID from its URL into `GOOGLE_SHEETS_SPREADSHEET_ID`.

### 6. Create the four tabs and headers
Create tabs named exactly `Jobs`, `Applications`, `Members`, `Activity`. In row 1 of each tab put these headers, one per column starting at A (case-sensitive, exact order):

| Tab | Headers (A -> ...) |
|---|---|
| `Jobs` | `JobID`, `Company`, `JobRole`, `JobType`, `WorkMode`, `Experience`, `StipendSalary`, `Location`, `JobURL`, `Deadline`, `Description`, `AddedBy`, `AddedAt` |
| `Applications` | `JobID`, `MemberID`, `Status`, `AppliedAt`, `ApplicationStage`, `Notes`, `LastUpdated` |
| `Members` | `MemberID`, `Name`, `Photo`, `Active` |
| `Activity` | `ActivityID`, `MemberID`, `Date`, `Action`, `JobID`, `Timestamp` |

In the `Members` tab add one row per member (these are real configuration rows, not sample data):

| MemberID | Name | Photo | Active |
|---|---|---|---|
| `anni` | Anni | `/assets/anni.jpeg` | TRUE |
| `lukky` | Lukky | `/assets/lukky.jpeg` | TRUE |
| `rishii` | Rishii | `/assets/rishii.jpeg` | TRUE |

Leave `Jobs`, `Applications` and `Activity` empty below the headers: all job and application data must come from real use of the app. The app never writes or repairs headers; if one is wrong it refuses to run and tells you which column. Tip: format columns A:M of `Jobs` etc. as "Plain text" to stop Sheets from reinterpreting dates or IDs if you edit by hand.

### 7. Share the spreadsheet
Share the sheet with the service account's `client_email` as **Editor** (the minimum needed to read and write; it needs no other access).

Intended human access (must be granted by the owner in Google Sheets -> Share; **not verified or granted by this repository**):

| Person | Account | Role |
|---|---|---|
| Anni | `sm.aniketraj@gmail.com` | Owner |
| Lukky | `diwanlukky@gmail.com` | Editor |
| Rishii | `happy.rishi2004@gmail.com` | Editor |

### 8. Verify the connection (no credentials exposed)
Start the app, sign in as any member, then open `http://localhost:3000/api/sheets/status` in the same browser. A healthy setup returns each tab with `"ok": true`, a valid row count and a `rowIssues` count. Problems are described per tab (for example `Tab "Jobs" column 3 should be "JobRole" but is "Role"`). The response never contains credentials or cell contents. Typical failures: `503 ... missing: GOOGLE_...` (env not set), `502 ... not shared with the service account` (step 7), `503 ... does not match the expected header row` (step 6).

## Phase 4 setup
- Add headers `FollowUpAnswer` and `FollowUpAnsweredAt` to `Applications!H1:I1` (until then the 7-day follow-up is off).
- New environment variables (see `.env.example`): `CRON_SECRET`, `RETENTION_CLEANUP_ENABLED` (keep `false` until you have reviewed a dry run), `SHEETS_CACHE_TTL_MS`, `NEXT_PUBLIC_AUTO_REFRESH_MS`, `APP_TIMEZONE`.
- Retention dry run: `GET /api/cron/retention` with `Authorization: Bearer <CRON_SECRET>` lists what would be deleted and deletes nothing.

## Data rules
- Jobs are shared; each member has their own application row per job, keyed by `(JobID, MemberID)`.
- Application statuses: `Not Applied` (implicit when no row exists), `Applied`, `In Progress`, `Interview`, `Offer`, `Rejected`. Stages: `Submitted`, `Shortlisted`, `Online Assessment`, `Screening`, `Technical Interview`, `HR Interview`, `Final Round`, `Offer`, `Closed`.
- Allowed moves: `Not Applied` -> `Applied`; `Applied` -> `Not Applied`/`In Progress`/`Interview`/`Offer`/`Rejected`; `In Progress` -> `Interview`/`Offer`/`Rejected`; `Interview` -> `In Progress`/`Offer`/`Rejected`; `Offer` -> `Rejected`; `Rejected` -> `In Progress`/`Interview`. Re-saving the same status (to edit stage/notes) is allowed.
- Job types: `Internship`, `Full-time`, `Part-time`, `Contract`. Work modes: `Remote`, `Hybrid`, `On-site` (optional).
- Timestamps (`AddedAt`, `AppliedAt`, `LastUpdated`, `Timestamp`) are ISO 8601 in UTC (`2026-10-12T08:30:00.000Z`). `Deadline` and `Activity.Date` are `YYYY-MM-DD`; `Activity.Date` is the calendar date in `APP_TIMEZONE`.
- IDs are generated by the server: `job_<uuid>` and `act_<uuid>`.
- Activity actions: `login`, `visit`, `job_added`, `job_applied`, `job_unapplied`, `application_updated`, `follow_up_answered`, `job_updated`, `job_deleted`.
- Cells are written as plain text (Sheets `RAW`), so values such as `=SUM(...)` are never executed as formulas.

## Reference images
The files in `assets/` are UI design references only. They are never rendered as page content and none of their visible text is used as data. Nothing in this repository seeds the spreadsheet.
