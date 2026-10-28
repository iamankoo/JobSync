# JobSync — Session Handoff Summary

> Read this first in a new session. Last updated **2026-10-28, ~03:40 IST**.
> Items marked **[VERIFIED]** were checked in Production/the sheet; **[NEEDS VERIFICATION]** were not yet confirmed;
> **[USER-REPORTED]** were confirmed by the user, not by me.

---

## 🔄 UPDATE 2026-10-28 evening (supersedes the "open issue" in §3 and parts of §2/§5)

**Why Network Finder stopped after the morning run [VERIFIED from the sheet + Vercel logs]:**
- Only 5 companies were ever queued today (all 02:15–02:50; HN thread + remoteintech are the only wired sources and
  most posts are rejected). Window 1 finished 4 of 5 by 03:55; the 5th carried over and ran at 10:05. After that
  discovery found **nothing new** in any later window (`ledger:…#enqueued` stayed 5; `cursor:remoteintech` stuck at 409
  since 03:15 because a pass that ran past the deadline was killed before it saved its cursor).
- From ~18:40 every call either **504'd at 60 s** (rate-limited Sheets writes retried up to 5× with 1–8 s sleeps each,
  past the run's deadline) or **409 busy** (the killed run never released its 5-min lock, which outlived the next
  5-min call) — so only about 1 call in 3 even started, and those timed out. Cron-job.org config was fine (unchanged).
- Vercel Hobby keeps only ~1 h of runtime logs, so earlier call history was not available; conclusions come from the
  sheet state.

**Fixes (this branch):** Sheets retries stop at the run deadline (`setSheetsRetryDeadline`); run lock TTL 75 s
(`RUN_LOCK_TTL_MS`), queue lease 90 s; discovery sources get a `deadline`, remoteintech stops early and keeps its
cursor, a source is not started with <15 s left. Regression tests: `tests/integration/network-finder-reliability.test.ts`.

**Job discovery now (`runDailyJobSearch`, `job-eligibility.ts`, `job-allocation.ts`):** per kind (internship, full-time)
target **15/day = 5 US (remote only) + 5 India (remote/hybrid/on-site) + 5 other countries (remote only)** and **5 per
member** (Anni/Lukky/Rishii), assigned by each member's VERIFIED skills (never the 200-skill taxonomy). Strict filters:
2027/fresher eligible, no CGPA/backlog, no senior/experienced-only, pay minimums (remote internship ₹30k/mo, India
on-site ₹50k/mo, full-time ₹10 LPA; undisclosed pay allowed only for explicit-fresher listings on an official board,
noted on the job), paid portals rejected. Quality beats quota. Official company boards (Greenhouse/Lever/**Ashby**) rank
first, then LinkedIn (**not automated** — terms forbid it), then Remote OK/Arbeitnow. One search per kind per hour.
**Rishii has no verified skills yet, so he currently receives no jobs** — add his resume facts to
`member-email-profiles.ts` to enable his 5. Env `NETWORK_FINDER_DAILY_INTERNSHIPS/FULL_TIME` default 15 (not set in Prod).

**Drafts now:** `company-research.ts` reads the company's OWN site (meta description, verbatim) and careers board; each
member is pointed at the real opening that fits their verified skills (`pickJobForMember`); no verifiable opening →
role-family email, no invented job. Validation rejects wrong role, missing role/company, other member's identity,
unverified skills, invented company facts/familiarity, generic text that ignores the company/job. NF companies' jobs are
now saved BEFORE their contacts' drafts. Tests: `network-finder-personalised-drafts.test.ts`.

---

## ⛔ STOPPED HERE FOR TODAY (older note, kept for history)

Tomorrow, in this order:
1. Read `summary.md` (this file).
2. Check the current Production / Google Sheet Network Finder state (read-only, **a single read — no repeated
   polling**, it shares Production's Sheets quota): `NF_State`, `NF_Queue`, `NF_Companies`, `NF_Selections`,
   `Connections`, `NF_Drafts`, plus Vercel logs for `/api/cron/network-finder`.
3. Verify how many companies from the **02:00–03:59 window** (ledger `2026-10-28#0`) completed (was 2 of 5 at 03:40).
4. Verify contacts, selections and Gmail drafts (incl. drafts for the non-selected contacts, which had none yet).
5. Verify the **06:00–07:59 window** (ledger `2026-10-28#1`) if it has occurred.
6. Check that the scheduling fix keeps working **and** check the open timeout issue (see §3 "Open issue").
7. Only debug if the expected processing did not occur.
8. Do not make unrelated changes.

---

## 1. Current Production state

| Item | Value |
|---|---|
| Production deployment | `dpl_6kQWcB6sMUGtG5Tp2JbKpaGMuD5x` — `jobsbyarillabs-gw0h4kkdm-iamankoos-projects.vercel.app` — **Ready** [VERIFIED 03:20 IST] |
| Production alias | `https://jobsbyarillabs.vercel.app` → that deployment [VERIFIED] |
| Built from | `main` @ `194dd83` (merge of PR #7, commit `393bbc9`) [VERIFIED via GitHub deployment record] |
| Feature branch | `profile-gmail-network-finder` (all work happens here; merged to `main` via PRs) |
| Working tree | clean before this docs commit [VERIFIED] |

Note: this `summary.md` commit (docs only) is merged after the above; if it is deployed, the new deployment carries
no behaviour change.

**Latest fix (PR #7):** Network Finder discovery was consuming the whole 50 s run budget on every call, so queued
companies were never processed. Now queued work is processed first and discovery only tops the queue up when enough
time remains. Details in §2.

---

## 2. Network Finder

### Schedule
- **cron-job.org** calls `GET /api/cron/network-finder` **every 5 minutes**, header
  `Authorization: Bearer $NETWORK_FINDER_CRON_SECRET`. Configured by the user; working [VERIFIED: 200s in logs].
- Off unless `NETWORK_FINDER_ENABLED=true` (it is on in Production).
- Timezone: `APP_TIMEZONE` (set in Production; code default `Asia/Kolkata`). India time confirmed from data [VERIFIED].
- **Batch windows (IST):** 02:00–03:59, 06:00–07:59, 10:00–11:59, 14:00–15:59, 18:00–19:59
  (`BATCH_WINDOWS` in `src/lib/network-finder/scheduler.ts`). Ledger key per window: `YYYY-MM-DD#<0..4>`.
- **Max 10 companies per window** (`BATCH_SIZE`), 50/day. **1 company per call** (`maxCompaniesPerTick` default 1).
- Run budget **50 s** (`RUN_BUDGET_MS`), Vercel function limit 60 s (`maxDuration`). One run at a time
  (run lock in `NF_State`, 5 min TTL); a concurrent call returns **409 busy**.
- Responses: 401 bad secret, 503 disabled, 409 busy, 200 otherwise (counts only, no names/emails).

### Each call (`runScheduledCycle`, `src/lib/network-finder/run.ts`)
1. Sent-draft tracking.
2. Manual-connection drafts (1 per call).
3. **Batch step** (`runBatchTick`, only inside a window).
4. Pending drafts (up to 6).
5. Daily job search + job re-checks if time remains (outside windows too).

### Batch step (after the fix)
- Nothing queued → discovery first (finds up to `remaining` companies, queues them).
- Something queued → **process a queued company first**; afterwards top up the queue only if ≥ 40 s left
  (`DISCOVERY_TIME_MS`). A company is never started with < 30 s left (`COMPANY_TIME_MS`); it stays queued.
- When the window's 10 are done (or nothing more can be found), **one** team push summary is sent.

### Discovery sources actually wired (`buildRealDeps`)
- **Hacker News "Who is hiring"** (hn.algolia.com API) and the **remoteintech** GitHub list.
- Size/country enrichment: **Apollo organization enrich** (account 1 only, Free plan; people search is not available
  on Free) → falls back to the company's own pages (rules / Nemotron).
- Contacts: the **company's own website** (team/about pages, robots-respecting, 1 req/s per site).
- Jobs: company boards (Greenhouse/Lever linked from site), RemoteOK, Arbeitnow.
- **YC company directory, Wellfound and LinkedIn are intentionally NOT wired** (their terms/robots forbid automated
  access). Do not claim they are active.

### Qualification and processing
- Companies ≤ 250 employees, size tiers 25/100/250, US + SG, GB, CA, DE, AE, AU, FR, IT, PL; size/country must come
  from a real source (never guessed).
- Per company: up to **3 people** (recruiter → hiring manager → founder priority), saved to **Connections** as
  owner **Anni**, status "Not Connected", via the normal Connections service. Jobs saved to **Jobs** as Anni.
- **One selected contact per company** → `NF_Selections`, assigned round-robin Anni/Lukky/Rishii (Notes:
  "Assigned to"). Record owner stays Anni.
- **Gmail drafts** for every NF contact × all three mailboxes (selected contact first; others via the pending-drafts
  worker in later calls).
- Status in `NF_Companies`: `queued` → `processed` / `no_contacts` (site names no staff) / `failed` (after 5 attempts).

### Emails / no email
- Only **published** emails, or emails **predicted from a published pattern on the same domain**, labelled in Notes
  "Predicted / Unverified — VERIFY BEFORE SENDING". **Never invented.**
- No email available → contact saved without one; NF drafts are still created **without a recipient** (member adds it
  before sending).

### Duplicate protection
- Companies: `NF_Companies` registry — known companies are never re-queued; queue item ids `company:<key>`.
- Contacts: dedupe by normalised name + company; re-running a company adds no contacts/selection/drafts.
- Drafts: `NF_Drafts` ledger key `contact:<connectionId>:<member>`; created/sent = never rewritten.
- Jobs: dedupe by company+title and URL.

### Limits
- **1,000 Connections** (`NETWORK_FINDER_CONTACT_LIMIT`): NF stops adding contacts and notifies all three once a day.
  Nothing exported or deleted.
- Apollo account 1 Free-plan limits; Apollo problems are warnings only.

### Carry-over
- Queued companies stay in `NF_Queue` across calls and windows; the next call claims them first. A queue item left
  `running` by a crashed call is re-claimable after its 5-minute lease. Failures retry with backoff (rate limits don't
  use up an attempt). Each window's 10 counts separately in its own ledger key.

### The 03:10 IST bug and fix
- **Symptom:** at 03:10 IST, 0 NF connections despite the active window.
- **Diagnosis (read-only) [VERIFIED]:** cron/auth/enabled/timezone/window/sources/writes all fine. 5 companies were
  queued 02:15–02:50 but **never claimed** (attempts 0, no errors). `runBatchTick` re-ran discovery on every call
  while fewer than 10 were queued; discovery took ~50 s, then the 30 s per-company check stopped the loop.
- **Fix:** commit `393bbc9`, PR #7, merge `194dd83`, deployed 03:20 IST (`dpl_6kQWcB6s…`).
- **Post-fix verification [VERIFIED]:** 03:20 call processed company 1 (`no_contacts`); 03:25 call processed company 2
  (3 contacts, 1 selection, 3 drafts). Queue items moved to `done`; `LastProcessedAt` set; ledger `2026-10-28#0 = 2`.

---

## 3. Current Network Finder run status (latest read ~03:38–03:40 IST)

[VERIFIED at that time]
- 5 companies queued initially (all from HN; 3 US, 1 AU, 1 DE; tier 25). `ledger:2026-10-28#enqueued = 5`.
- **2 completed** (ledger `2026-10-28#0 = 2`): one `no_contacts`, one `processed`.
- Queue: 2 `done`, 1 `running` (company 3), 2 `pending`; attempts 0; no `LastError`.
- **5 NF contacts** in Connections (3 from company 2, 2 so far from company 3). None has an email address.
- **2 selections**: one assigned to Anni (drafted for anni, lukky, rishii), one to Lukky (not drafted yet).
- The first selected contact has drafts **created in all three Gmail mailboxes** (no recipient — no email).
- Other 4 NF contacts: **no drafts yet** (expected from the pending-drafts worker in later calls) **[NEEDS VERIFICATION]**.
- All three Gmail accounts (anni, lukky, rishii) show `connected` in `NF_GmailAccounts`.

### Open issue [NEEDS VERIFICATION]
- The **03:30 call timed out at 60 s (504)** after repeated Google Sheets `rate_limited` retries while processing
  company 3 (the 03:25 call also logged Sheets rate-limit retries but finished). The run lock was not released, so the
  **03:35 call returned 409 busy**.
- Expected self-recovery: lock expired 03:35:58; company 3's queue lease (5 min) expires ~03:36; the **03:40 call**
  should re-claim company 3 (re-running is idempotent — no duplicate contacts/selection/drafts) and continue.
- **Likely contributor — my own verification polling:** local read-only scripts use the **same Google service account
  (same Sheets read quota)** as Production. Between ~03:20 and ~03:40 IST I polled all NF tabs every ~30 s; at 03:40 a
  local read itself got **429 RESOURCE_EXHAUSTED**. That polling very likely added to the rate limiting that slowed
  the 03:25/03:30 runs. Polling was stopped at ~03:41 IST.
  **Lesson: do not poll the production sheet repeatedly while Network Finder runs; use one read at a time, minutes
  apart, or Vercel logs.**
- Tomorrow: confirm recovery happened, count how many of the 5 finished in window 1, and check whether Sheets rate
  limiting / 60 s timeouts recur **without** local polling. Only if they recur, consider a fix (e.g. stop Sheets
  retries near the deadline). **No fix has been made for this.**
- Let the first window finish naturally; do not rerun manually.

---

## 4. Gmail draft system

- Automatic, driven by the existing 5-minute cron worker (`runPendingDrafts`). **No Create Gmail Draft button**
  (removed in PR #5).
- Eligible: **manually added** connections **with an email**, "Not Connected", created in the last 30 days; **Network
  Finder** contacts created in the last 3 days (with or without an email — without one, the draft has no recipient).
  Manual connections go first (one per call), then today's selections, then oldest.
- One draft in **each of the three members' own Gmail** (Anni, Lukky, Rishii), each written as that member.
- **Drafts only — never sent.** No send/delete/modify of Gmail messages.
- Ledger `NF_Drafts` (one row per connection × member): `created`/`sent` = done, never rewritten; member not connected
  → one `skipped` record, retried automatically after reconnecting; `failed` → retried later.
- Sent tracking (`GMAIL_TRACK_SENT=true`, metadata scope): a sent NF outreach draft moves the Connection
  Not Connected → Messaged (never downgrades); updates Draft/Sent counts.
- Connection details show read-only drafting status ("Drafted · n of 3").
- **Gmail Drafts page** (`/gmail`): each member's own drafts — company, person, designation, email, Draft/Sent status
  — plus Draft and Sent counters; empty state "Drafts are coming soon".
- Adam (manually added by Lukky) was used to verify three-mailbox automatic drafting **[USER-REPORTED]**.

---

## 5. Email template system (PR #6, live)

Files: `src/config/members.ts`, `src/config/skills.ts`, `src/config/member-email-profiles.ts`,
`src/config/email-templates.ts`, `src/lib/network-finder/email-composer.ts`; wired in `draftForContact`
(`pipeline.ts`), `providers/brain.ts`, `providers/nemotron.ts`.

- **10 role templates:** Full Stack, Frontend, Backend, Software Engineer, AI/ML, Data Analyst, Data Engineer, LLM,
  Python/Automation, Mobile/Flutter.
- **Role selection:** the company's open job in Jobs (newest, early-career relevant first) → job title keywords
  (longest match wins) → a clear job description → otherwise "Software Engineer". No job → "{role} opportunities".
- **Subjects:** "Application for {job title} — {company}"; "Intern" → "Internship"; no job →
  "Application for {role label} opportunities — {company}".
- **Skills:** fixed taxonomy of **exactly 200 unique skills** (`SKILLS`). An email names 4–8 skills chosen **only from
  that member's verified profile**, ranked by role + job description. Taxonomy skills are never claimed unless in the
  member's verified list. 1–2 relevant projects/internships from the verified profile.
- **Personalisation:** "Dear {first name}," when a real first name is known, else "Dear Hiring Team,"; exact company
  and role; company facts only from verified discovery text (else a neutral sentence); remote line only when relevant.
- **Writing:** Nemotron writes body paragraphs only, from a facts plan; subject/greeting/signature are fixed by code.
- **Validation** (every draft): 180–300 words (lower minimum for thin profiles), no placeholders/ellipsis/cut-off,
  company mentioned, no other member's name/links, no internal ids (anni/lukky/rishii), no banned buzzwords, no
  unverified company claims (e.g. funding), **no unverified skills**, full signature last. Fails → deterministic
  template fill from verified facts (never empty, invented or truncated). Nemotron down → same fallback.
- **Resume:** drafts have no attachments (never did); text offers "I would be glad to share my resume".
- **Signature:**
  ```
  Best regards,
  {Full Name}
  LinkedIn: {url}
  GitHub: {url}
  ```
  (optional `NETWORK_FINDER_SIGNATURE_<MEMBER>` appended under `-- `).

### Fixed member identities
Internal short names stay **Anni, Lukky, Rishii** in the app; drafts use full names.

| App name | Full name | LinkedIn | GitHub |
|---|---|---|---|
| Anni | Aniket Raj | https://www.linkedin.com/in/raj-aniket/ | https://github.com/iamankoo |
| Lukky | Lakshya Singh | https://www.linkedin.com/in/lakshya-singh-243510302/ | https://github.com/lukkydiwan |
| Rishii | Rishi Raj | https://www.linkedin.com/in/rishi-raj-8bb5a8366/ | https://github.com/Rishi-Ra-1j4 |

(Lukky's LinkedIn was originally supplied without ".com"; corrected to the URL above.) Anni uses he/him.

---

## 6. Member profiles / verified data (`src/config/member-email-profiles.ts`)

- **Aniket / Anni:** from his stored resume — final-year B.Tech CSE (AI & DS) at IIIT Manipur (2027), full-stack
  developer with three internships (Amdox, Codec Technologies, Ramyoz Solutions), projects RealPath, JobSync,
  PathoView; CodeChef achievement; location Delhi, India; broad verified skill list. (The local resume copy used for
  extraction was deleted; no contact details stored.)
- **Lakshya / Lukky:** only from his own reference email — final-year CSE (AI & DS); JavaScript, React, Node.js,
  Express, MongoDB, Python, REST APIs, LLM integration, RAG; one highlight (MERN + AI integration projects).
- **Rishi / Rishii:** **no verified data** → drafts are short (~100 words) and make no skill/project claims.
  Needs his resume or a reference email. **Do not invent missing profile information.**

---

## 7. Profile Photos (PR #5, live)

- Separate **Photos library** on the Profile page (MemberFiles kind `library_photo`), independent of the Professional
  Photo/avatar (kind `photo`).
- Upload / view / download / delete; **max 10 photos**; **JPEG/PNG/WebP**; **max 2 MB each**.
- Photos never change the avatar; avatar changes never affect the library.
- Same Profile Lock and owner-only protections as resumes. Stored in the sheet's chunked file store.
- Live in Production since PR #5; manual check of Photos was left to the user **[USER-REPORTED / not verified by me]**.

---

## 8. Cron

- **Network Finder** (cron-job.org, every 5 min): configured and working. **Do not change** unless debugging
  requires it.
- **Daily notifications** (`GET /api/cron/daily-notifications?slot=morning|night`, `Authorization: Bearer $CRON_SECRET`
  — not the NF secret): Morning Motivation **10:00 IST**, Nightly Progress **22:00 IST**. Each member gets each slot at
  most once per local date; calls outside the slot's window return **409 outside_window** (auth OK, wrong time).
- Night notification tested and received **[USER-REPORTED]**.
- Do not change cron configuration casually.

---

## 9. Decisions made

- Leave YC / Wellfound / LinkedIn discovery unwired.
- Do not modify cron-job.org unless there is a confirmed problem.
- Network Finder stays automatic; NF records owned by Anni; selections round-robin across all three.
- Gmail drafts automatic for manual (with email) and NF connections, in all three mailboxes; no manual button.
- Drafts are never sent automatically; Nemotron never sends.
- Full names + each member's own LinkedIn/GitHub in their drafts.
- 200-skill taxonomy, but only verified skills are claimed.
- Never invent email addresses, contact info or company facts; predicted emails are labelled unverified.
- Contact limit 1,000 → pause + notify (no export/delete).
- Next.js security upgrade is a separate future task.

---

## 10. Test / quality status (latest actual runs, 2026-10-28)

- Typecheck (`tsc --noEmit`): clean. Lint (`eslint src tests`): clean. [run after PR #7 change]
- Unit/integration (vitest): **1,060 / 1,060 passed**, 63 files. [run after PR #7 change]
- NF scheduling regression tests (`tests/integration/network-finder-free.test.ts`, "scheduling inside the run budget"):
  5 tests pass; 4 of them fail on the old code (verified by temporarily restoring it).
- Browser (Playwright isolated config, workflow-desktop + workflow-mobile, `connections.spec.ts` + `profile.spec.ts`):
  **48 passed, 10 skipped** — last run before the PR #6 commit; not re-run for PR #7 (no UI change).
- Known pre-existing issues: axe accessibility and isolated responsive e2e tests were already failing on `main` before
  this work (not caused by it). The isolated Playwright dev server sometimes fails to start on the first attempt; a
  rerun works.

---

## 11. Change history

| Change | Commit | PR | Merge |
|---|---|---|---|
| Profile / Gmail / Network Finder initial work (Profile page, Profile Lock, resumes, Gmail OAuth, NF pipeline) | `c3645c0` | #1 | `33bc7be` |
| Responsive UI polish (Profile, Gmail Drafts) | `f92ee43` | #2 | `581186a` |
| Gmail Drafts page list + Draft/Sent counters; full-name signatures | `8a7d43e` | #3 | `0ddd495` |
| Gmail drafts for manually added connections (+ temporary Create Gmail Draft button) | `440c70c` | #4 | `90d4786` |
| Automatic drafting of all new connections into all 3 mailboxes (button removed); Profile Photos library | `6347a1f` | #5 | `7effe32` |
| Structured email templates, 200-skill taxonomy, verified member facts, validation | `9ed89bd` | #6 | `699cd6e` |
| NF scheduling fix: queued companies before rediscovery | `393bbc9` | #7 | `194dd83` |

Earlier (before these PRs): NF code first deployed from a working tree (2026-10-27), NF Sheets tabs created
(`NF_GmailAccounts`, `NF_Drafts`, `NF_Companies`, `NF_Queue`, `NF_State`, `NF_Selections`), cron-job.org job created by
the user, Members K/L headers + MemberFiles tab created, `PROFILE_RECOVERY_ANSWER_HASH` moved to an env var.

---

## 12. Safety / secrets

- **Never** put passwords, API keys, OAuth client secrets, Gmail access/refresh tokens, `CRON_SECRET`,
  `NETWORK_FINDER_CRON_SECRET`, VAPID keys, `GMAIL_TOKEN_ENCRYPTION_KEY`, password hashes, recovery answers or any
  environment values in this file or in output. Document variable names only.
- `.env.local` and `.vercel` are git-ignored; only `.env.example` is tracked.
- **`.env.local` `GOOGLE_SHEETS_SPREADSHEET_ID` points to the PRODUCTION sheet.** Plain `npm run dev` writes
  production data; local NF/Gmail testing must use `SHEETS_TEST_BACKEND=memory`. Forensic reads use read-only scope.
- The local `GMAIL_TOKEN_ENCRYPTION_KEY` does **not** match Production (Production Gmail tokens can't be decrypted
  locally).
- Do not modify existing spreadsheet data/tabs, Vercel env vars, Gmail OAuth or cron-job.org without explicit approval.
- Do not commit, push, merge or deploy without the user's explicit approval for that task.
- Do not include private email contents or contact details unnecessarily.
