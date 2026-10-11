# Deployment (Vercel)

Production: **https://jobsbyarillabs.vercel.app** (Vercel project `jobsbyarillabs`, GitHub repo `iamankoo/JobSync`, branch `main`).

## Why this URL
The preferred name `jobsync.vercel.app` could not be claimed: Vercel answered `The chosen alias "jobsync.vercel.app" is already in use (403)` (another project already owns it). The agreed fallback `jobsbyarillabs.vercel.app` was claimed and is assigned to the production deployment. No third name was used.

## Configuration in the repository
- `vercel.json` pins `"framework": "nextjs"`. (A project created from the CLI defaults to the "Other" preset, which serves an empty `public` folder and answers 404 for every route. Pinning the framework makes the setup reproducible.)
- `.vercelignore` keeps local build folders, `node_modules`, test artefacts and every `.env*` file (except `.env.example`) out of CLI uploads.
- Security headers (`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`) come from `next.config.ts`; Vercel adds HSTS.

## Environment variables (Production only; names, never values)
All are server-side and stored as **Sensitive** in Vercel (not readable after saving). None is `NEXT_PUBLIC_`.

| Name | Purpose |
|---|---|
| `GOOGLE_SHEETS_SPREADSHEET_ID` | The real production spreadsheet |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service account that reads/writes it |
| `GOOGLE_PRIVATE_KEY` | The service account key (quotes and `\n` escapes are accepted) |
| `SESSION_SECRET` | Signs session cookies (generated for production, >= 32 chars) |
| `SESSION_MAX_AGE_SECONDS` | Session lifetime (28800 = 8 h) |
| `ACCESS_CODE_ANNI`, `ACCESS_CODE_LUKKY`, `ACCESS_CODE_RISHII` | Member access codes (required in production: login fails closed without them) |
| `APP_TIMEZONE` | Calendar timezone for "today" (Asia/Kolkata) |

**Deliberately NOT set in production:** `RETENTION_CLEANUP_ENABLED` (30-day cleanup stays disabled until the owner approves it after a dry run), `CRON_SECRET` (no scheduled job is configured), `SHEETS_TEST_BACKEND` / `TEST_SEED_KEY` (test-only; the app refuses the in-memory backend in production and `/api/test/seed` answers 404), `GOOGLE_TEST_SPREADSHEET_ID` (tests only, lives in `.env.test.local`). Optional tuning: `SHEETS_CACHE_TTL_MS` (default 5000) and `NEXT_PUBLIC_AUTO_REFRESH_MS` (default 30000).

Set or rotate a value (the value is read from stdin, not typed into history):
`vercel env add NAME production --sensitive --force` then redeploy (`vercel deploy --prod`). Never paste keys into chat or commit them.

## Deploy
- Push to `main` (the repo is connected, so Vercel builds and promotes it), or run `vercel deploy --prod` from the repo root.
- Build: `npm run build` (Next.js). Required checks before deploying: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e`, `npm run test:e2e:isolated`.
- Google side: the production spreadsheet must stay shared with the service account as Editor, and `Applications!H1:I1` must keep the `FollowUpAnswer` / `FollowUpAnsweredAt` headers.

## Rollback
1. Vercel dashboard -> project `jobsbyarillabs` -> Deployments -> pick the last good production deployment -> **Promote to Production** (instant, no rebuild). CLI: `vercel rollback` (or `vercel promote <deployment-url>`).
2. If the cause is a bad environment variable, fix it with `vercel env add ... --force` and redeploy.
3. Code rollback: `git revert <commit>` on `main` and push (never force-push); Vercel redeploys.
4. Data is never changed by a deployment. To undo a data mistake, use the spreadsheet's own version history.

## Production verification performed (2026-10-11)
Against the live URL, with real data (no jobs or applications were created or changed; signing in only appends `login`/`visit` activity rows):
- HTTPS and the production alias; `/login` 200; protected pages redirect to `/login`; protected APIs return 401; `/api/test/seed` returns 404.
- All three access codes sign in (Anni 0001, Lukky 0002, Rishii 0003); a wrong code is refused; logout ends the session (APIs 401, pages redirect).
- All five sidebar destinations load for each member with no error state; a spoofed `memberId` in a request body is rejected (400).
- All 7 shared jobs are visible to every member (3 by Lukky, 3 by Rishii, 1 by Anni), with independent per-member statuses.
- No horizontal overflow on any page at 320x568, 375x812, 768x1024 and 1366x800.
- The downloaded JavaScript (59 responses, about 3.9 MB) contains none of: the spreadsheet IDs, the service-account email, a private-key fragment, or the names of the secret environment variables.

## Known limitations
- **Google read quota** (about 60 reads/min for the service account): normal use by three members is well inside it, but rapid scripted navigation produced `rate_limited` log lines. Pages degrade to a safe error state and recover on the next load. If real use ever hits it, raise `SHEETS_CACHE_TTL_MS` in Vercel (trade-off: other members' changes can take that long longer to appear).
- **Follow-up on production** has not been exercised by a real due answer yet; it is covered by the isolated and live test-sheet suites. The first real answer after a job turns 7 days old is the production check.
- **Access codes** are 4-digit codes (as specified). They are rate-limited, but consider longer codes: change the `ACCESS_CODE_*` variables and redeploy.
- Preview (non-production) deployment URLs are protected by Vercel Authentication; the production domain is public.
