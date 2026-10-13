# Chrome push notifications

Real Web Push (service worker + VAPID) for the three members. Google Sheets stays the only database.

## What is sent

| Event | Recipients | Title | Body | Opens |
|---|---|---|---|---|
| A member **adds a job** (after the row is saved) | the **other two** members | `Anni added a job: Software Engineer` | `Acme Corp — tap to view the job.` | All Jobs with that job's details open |
| A member marks a job **Applied** (Not Applied → Applied, after it is saved) | the other two members | `Lukky applied for Backend Developer — hurry up!` | `Acme Corp — open JobSync to apply too.` | the same job |
| **10:00 AM** daily | each member, privately | `Good morning, Anni! ☀️` | `<one of 100 quotes> Let's start applying and posting jobs!` | Add Job |
| **10:00 PM** daily | each member, privately | `Hello, Lukky! 🌙` | `You added 6 out of 10 jobs today. Good but still we can do better, Lukky.` | Dashboard |

The sender is always the member of the server-validated session; the browser never names a sender or recipient. The actor is never a recipient (also filtered a second time right before sending). Notifications are sent **after** the Sheets write succeeded, after the HTTP response (`after()` from `next/server`), and any failure is logged by name only. A failed push never fails or rolls back a save.

Night thresholds (exact): 0–3 `Need more efforts, {Name}.` · 4–6 `Good but still we can do better, {Name}.` · 7–9 `Nice going, let's finish the target, {Name}.` · 10+ `Today's target achieved! Good night, {Name}.` (The spec's example ends the 4–6 line with `!`; the exact-threshold list ends with `.`, which is what is implemented.)

The count is the number of valid `Jobs` rows with `AddedBy` = that member whose `AddedAt` falls on the current **local calendar day** in `APP_TIMEZONE` (each JobID once; rows with an invalid timestamp are ignored; applications, logins and other members' jobs are never counted). A member with 0 jobs still gets the 0-job message.

## Onboarding (browser)

On the Dashboard, once any follow-up question is out of the way, a JobSync dialog explains the feature with **Enable Notifications** and **Not now**. Chrome's native permission prompt is only ever requested from that button click.

| Permission | Behaviour |
|---|---|
| `default` | Dialog shown. "Not now"/Escape/✕ dismiss it for the rest of the browser session (no loop). |
| `granted` | No dialog. The browser is silently (re)registered on every app page (server write at most every 12 h). If registration fails, the dialog reappears in an error state with **Try again**. |
| `denied` | Dialog explains how to allow notifications in Chrome site settings, with **Check again**. The native prompt is never called again. |
| No Push API | Dialog says push is unavailable in this browser. |

The dialog never blurs or blocks the app permanently. If the member clicked "Not now" they see it again after their next login (new browser session) until they enable notifications.

## Persistence (Google Sheets) — two optional tabs

Both tabs are created by hand (row 1 headers). While a tab is missing the app works exactly as before; the related feature is simply off (`/api/sheets/status` reports the tab but stays `ok`).

**`PushSubscriptions`** (A:G): `SubscriptionID | MemberID | Endpoint | P256dh | Auth | CreatedAt | LastSeenAt`
One row per member device. `SubscriptionID` = `sub_` + first 32 hex chars of SHA-256(endpoint) (log-safe). Endpoint/keys are secrets: never returned by any API, never logged. Max 8 devices per member (oldest dropped). Rows are removed when the push service answers 404/410, on logout of that browser, or on `DELETE`.

**`NotificationLog`** (A:I): `LogKey | ClaimID | MemberID | Type | LocalDate | Status | ClaimedAt | UpdatedAt | Detail`
Idempotency ledger for the scheduled messages. `LogKey` = `morning|night:<member>:<YYYY-MM-DD>`; `Status` = `claimed | sent | failed`. Rows older than 14 days are pruned.

**Exactly-once claim.** Sheets has no transactions, so a run appends a `claimed` row, re-reads, and the claim on the **earliest row** wins; losers back off. A `sent` row ends all attempts; `failed` rows and claims older than 5 minutes (a crashed run) do not block a retry. Tested with 2–3 simultaneous runs against both the fake and the real Sheets API.

Setup (production, **once, additive only** — creates two new tabs; existing tabs and data are untouched):
1. Add tab `PushSubscriptions` with headers in A1:G1 exactly as above.
2. Add tab `NotificationLog` with headers in A1:I1 exactly as above.
3. The service account already has Editor access to the spreadsheet.
Verify with `GET /api/sheets/status` (signed in): both tabs show `ok: true`.

## Environment variables (names only)

| Name | Where | Purpose |
|---|---|---|
| `VAPID_PUBLIC_KEY` | server (served to signed-in members by `/api/push/config`) | public VAPID key |
| `VAPID_PRIVATE_KEY` | server only, **Sensitive** | signs push requests; never sent to browsers |
| `VAPID_SUBJECT` | server, optional | `mailto:` or `https:` contact for push services (default `https://jobsbyarillabs.vercel.app`) |
| `CRON_SECRET` | server only, **Sensitive** | bearer secret for `/api/cron/daily-notifications` (and the existing retention endpoint) |
| `APP_TIMEZONE` | existing | local day/time for the scheduled messages (default `Asia/Kolkata`) |

Generate keys locally (do not paste them anywhere): `npx web-push generate-vapid-keys --json`. Store them with `vercel env add VAPID_PRIVATE_KEY production --sensitive` (value from stdin). Rotating the public key makes every browser resubscribe automatically on its next page load (a subscription made with an old key is detected and replaced).

Setting `CRON_SECRET` also lets the bearer token call `/api/cron/retention`, which stays a **dry run** because `RETENTION_CLEANUP_ENABLED` is not set. Production retention cleanup remains disabled and is not scheduled.

## Security

- Subscription routes use the existing session + same-origin + active-member checks. The body is strict (a `memberId` is rejected). Registration always stores the session member.
- An endpoint already registered with different keys is refused (409): nobody can take over another member's subscription. The same endpoint + keys moves to the new member when someone else signs in on that browser.
- The server POSTs to subscription endpoints, so only real push hosts are accepted (`fcm.googleapis.com`, Mozilla autopush, `*.push.apple.com`, `*.notify.windows.com`; https, no port or credentials) — no SSRF.
- Click targets: the server only emits `/all-jobs?job=<JobID>`, `/add-job` or `/dashboard`; `public/sw.js` re-validates (same origin + allow-listed path) and falls back to `/dashboard`.
- **Logout** removes only *that browser's* subscription (best effort) so the next person on a shared browser doesn't receive the previous member's notifications; the member's other devices are untouched and the browser permission is kept, so the next login re-registers silently. If a session simply expires on a shared browser, the next login by anyone re-binds that browser to them.
- The cron endpoint requires `Authorization: Bearer $CRON_SECRET` (constant-time comparison), is `no-store`, and never logs the secret, endpoints or message text. Scheduled runs write only `PushSubscriptions` (expired devices) and `NotificationLog`; they never modify `Jobs` or `Applications`.

## Scheduling (10:00 AM and 10:00 PM) — read this

Endpoint: `GET /api/cron/daily-notifications?slot=morning|night` with the bearer secret. It sends only inside a local-time window (morning 10:00–11:59, night 22:00–23:59 in `APP_TIMEZONE`) and answers `409 outside_window` otherwise, so a mistimed call cannot send "good night" at noon. Status codes: `200` done (including "already sent"), `503` at least one member failed (retry the same call: only failed members are retried), `401/400/409` as described.

**Vercel plan limitation.** This project's Vercel team (`iamankoo's projects`) is on the **Hobby** plan (verified through the Vercel API). Hobby cron jobs can run **once per day per entry and are only accurate to the hour** ("a job set for 1:00 can fire anywhere from 1:00 to 1:59"; per-minute schedules are Pro-only) — see [Vercel cron usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing). Cron expressions are UTC, and `Asia/Kolkata` is UTC+5:30, so 10:00 IST is 04:30 UTC, which Hobby cannot hit. Two daily entries (one per slot) are allowed on Hobby, but each could fire up to ~59 minutes late and **cannot be guaranteed at exactly 10:00**.

Options (the code supports all of them unchanged):
1. **Vercel Cron on Hobby, approximate timing.** `0 5 * * *` (10:30–11:29 IST) for morning and `0 17 * * *` (22:30–23:29 IST) for night: always inside the accepted windows, but never at 10:00 sharp. No extra accounts.
2. **External scheduler (exact).** A free service such as cron-job.org calls the two URLs at exactly 10:00 and 22:00 IST with the bearer header (and can retry on non-2xx). Needs an account and the secret stored there.
3. **Vercel Pro.** Per-minute cron (`30 4 * * *` and `30 16 * * *` UTC). Costs money.

No schedule is configured in `vercel.json` until one of these is chosen. Vercel Cron does not retry failures; a scheduler that retries on `503` completes a partially failed run without duplicates.

## Quotes

`src/lib/push/quotes.ts`: 100 distinct original lines (≤ 80 characters). The pick is a deterministic pseudo-random walk per member and date (`quoteIndexFor`): different members usually get different quotes, the same member never gets the same quote two days running, and a retry always picks the same quote. Appending is safe; editing/reordering only changes which date maps to which line.

## Limitations

- Delivery depends on Chrome, the OS (battery optimisation, Do Not Disturb, notification settings), connectivity and Google's push service. Chrome on iOS and non-installed iOS web apps do not support this.
- The deduplication of "added/applied" notifications is per server instance (10 min) plus the notification `tag`, which collapses repeats on the device; upstream retries are additionally stopped because a duplicate job URL is rejected and an unchanged status reports `changed: false`.
- A notification link clicked while signed out lands on the login page and then the Dashboard (the deep link is not remembered).
- If recording `sent` in the ledger fails *after* delivery, a retry more than 5 minutes later could send that member's message again (extremely unlikely; the Sheets client already retries that write).
- Real Chrome delivery cannot be exercised by automated tests (headless Chromium here does not grant the notification permission and has no push service). See `docs/testing`.

## Troubleshooting

- *No dialog appears*: permission is already granted/blocked, "Not now" was clicked this session, or the push tabs/VAPID keys are missing (`/api/push/config` → 503 keeps the UI quiet).
- *Blocked*: Chrome → lock icon → Site settings → Notifications → Allow, then **Check again**.
- *Nothing arrives*: check `/api/sheets/status`, that `PushSubscriptions` has rows for the other members, that `VAPID_*` are set in Production and redeployed, and the OS notification settings. Logs show `[push] delivered x/y, expired n, failed m` (counts only).
- *Scheduled message missing*: call the endpoint manually with the bearer token; a `409` means wrong local time, `503` lists which member failed, and `NotificationLog` shows each member's status.
