# JobSync — Session Handoff Summary

> Read this first in a new session. Last updated **2026-11-01, ~12:30 IST** (the three 1 Nov updates below are the newest, newest first).
> Items marked **[VERIFIED]** were checked in Production/the sheet; **[NEEDS VERIFICATION]** were not yet confirmed;
> **[USER-REPORTED]** were confirmed by the user, not by me.

---

## UPDATE 2026-11-01 (source terms and yield research)

- **Amazon (amazon.jobs) — NOT integrated.** robots.txt only disallows `/internal` and `/en/search.json` works technically, but the site's footer links to Amazon's Conditions of Use, which prohibit "any use of data mining, robots, or similar data gathering and extraction tools". The location filter was also ignored in a test query. Terms forbid it.
- **Workday career sites (`*.myworkdayjobs.com`) — NOT integrated, terms unclear.** The `/wday/cxs/<tenant>/<site>/jobs` JSON works and a tenant's robots.txt (checked: NVIDIA) does not disallow it, but it is an undocumented front-end endpoint; there is no Workday API terms for it, each employer's own site terms apply (not reviewed per employer), and posting dates come only as "Posted N Days Ago" / "30+ Days Ago", which cannot be placed in the recency windows. Workday's own site terms forbid scraping workday.com (not the tenants). Needs the owner's approval per employer.
- **Himalayas, Remotive, Jobicy — evaluated, NOT integrated (0 qualifying).** Terms allow free API use with attribution (Remotive: max 4 requests/day, link back, no re-submission to other job sites; Jobicy: credit + link; Himalayas: free, 20 per request). Real yield with the real rules: Himalayas (India entry-level 120, India internships 134, worldwide entry-level 120 listings) 0 qualify, about 49 internships are "degree and batch not stated" on an aggregator (not an official employer board, so they stay uncertain); Remotive (48) 0; Jobicy (198) 0 (108 senior, 20 limited to a country).
- **More official boards:** 297 further Greenhouse/Lever tokens probed, 28 answered; only Hevo Data (Lever) produced qualifying roles (Pune/Bangalore) and was added.
- **Fix:** a title containing "Intern" is an internship even when the company tags it full time (so the stipend rules apply).
- **Reporting:** the `[daily-jobs]` log line and report carry `target` (15) and `shortfall` per kind.

## UPDATE 2026-11-01 (supply audit) — why 15 + 15 is not reached, and what changed

- **Counter check:** the day's funnel row (`<day>#funnel-<kind>`) is cumulative per day and matches the ledger and the Jobs sheet (1 Nov: 1 internship + 3 full-time). The earlier "saved 0 for 7 scans" came from aggregating one deployment's Vercel logs (the saves happened in earlier scans/deployments). 31 Oct: ledger 6 full-time + 1 internship vs sheet 4 + 0 — not explained by code (members may have deleted rows).
- **Measured supply (all 6 windows open, 145 boards, real eligibility rules):** 304 internship and 16,421 full-time listings → **2 internships and 5 full-time qualify**. Full-time: 13,232 wrong role (not one of the 13 families), 1,439 US/Canada-limited remote, 782 older than 120 days, 596 experience requirement, 272 uncertain (no degree and no fresher wording), 31 remote without India eligibility. Internships: 155 limited remote, 55 wrong role, 50 expired, 20 master's/PhD. The inventory, not the code, is the limit.
- **Changed:** (1) Greenhouse boards are listed WITH descriptions in one request (`?content=true`), so every software/data listing is decided on its own text instead of only early-career-looking titles; pay is looked up (one request) only for a listing that already meets every other rule. (2) 20 boards added, including the first 9 Lever boards (the seed list had none); 22 more Lever and 31 more Greenhouse boards were probed and yielded 0 qualifying listings at the time, so only India-heavy ones were kept. (3) A sweep (window-opening rule) is as long as the slowest ATS list (`sweepScans`), not total boards / 12.
- **Not changed:** every eligibility rule. Ashby, SmartRecruiters (robots.txt), LinkedIn, Workable (no jobs on probed accounts) are not used. Workday/Amazon career-site JSON were NOT integrated — terms of service unverified; needs the owner's decision.
- **Trade-off:** a content list is 0.1–6 MB per board; each board is read about once per sweep (~50 min).

## 🔄 UPDATE 2026-11-01 (third change): job notifications, admin rights, end-to-end checks

**Production:** `main` @ `50b6b39` (PR #18), deployment `uumrtW` Ready and receiving cron calls [VERIFIED]. Connection discovery still OFF.

### Notifications for discovered jobs (root cause: `notify:false`)
Jobs saved by the daily search never notified anyone: `existingJobs.create` passed `notify:false` for a batch summary that no longer exists.
Now every saved job is queued **after the row is saved** (`job-alerts.ts`, NF_State note `job-alerts`) and delivered to the **other two members** by the
cron's `job-alerts` step with the existing push layer (`notifyMember`): title "New job/internship found for <member>: <role>" (never "added by"),
body "<company> · <type> [· mode] — tap to view the job", link `/all-jobs?job=<id>`. Each recipient is removed from the job as soon as their delivery
succeeds; a failed delivery is retried for that recipient only (max 6 attempts, then dropped); expired/no devices count as handled; "push not
configured" is retried, not silently dropped. Rejected listings, duplicates and failed writes are never queued. Manual adds keep the old mechanism.
Tests (`job-alerts.test.ts`, 12): all three member combinations (6 notifications for 3 jobs), duplicate/rejected/failed-write → none, restart,
crash-before-flush, partial failure retry, expired device, push unconfigured, manual add per actor, visibility in All Jobs.
**[NOT VERIFIED IN PROD]**: no job has been saved since this deployed, so no real push has gone through the new path yet. Check the next saved job:
the other two members should receive "New … found for …".

### Administrator
`ADMIN_MEMBER_ID="anni"`, `isAdmin()` in `config/members.ts`; enforced **in the services** (`updateJob/deleteJob`, `updateConnection/deleteConnection`) from the
session member id (routes take identity only from the validated session; inactive members are refused first). Ordinary members: own records only
(403 `not_job_owner` / `not_connection_owner`). Owner/AddedBy/ids/AddedAt never change on an edit. Admin edit/delete of someone else's record writes
an Activity audit row (MemberID=actor, Action=`admin_edit`|`admin_delete`, JobID column = record id, timestamp); these are classified `AUDIT_ACTIONS`
(neither work nor presence, in no total). Job delete uses the existing rules (the job's application rows go, nobody else's); connection delete leaves the
draft ledger/Gmail drafts alone; edits never create connections or drafts (tests). UI: Edit/Delete on every job and connection for Anni, own records
only for Lukky/Rishii; delete confirmations unchanged. Tests: `admin-permissions.test.ts` (24, direct route calls incl. forged body/headers, inactive
admin, no session, cross-origin), unit UI tests, Playwright `connections.spec.ts` admin flow (desktop + mobile, 8/8).

### Tests (1 Nov, final)
typecheck + lint clean; **1,223 vitest (74 files)**; Playwright connections 8/8; live disposable-sheet job-window test passes.

---

## 🔄 UPDATE 2026-11-01 (second change): education, worldwide remote, progressive recency

**Production:** `main` @ `dd4e2cf` (PR #17), first deployed as `h8nCXb`; Ready and receiving cron calls [VERIFIED via GitHub deployment record + Vercel logs].
Connection discovery is still OFF; manual-connection drafting untouched; retention untouched; no production data deleted or rewritten.

### Eligibility rules now enforced (both kinds; every member identical — skills only rank)
1. **Education (2027 B.Tech / B.E.)** — `job-education.ts`. REJECT: postgraduate-only (Master's, M.Tech, M.E., MBA, MSc, MCA, PhD/doctoral)
   when stated as a requirement and no bachelor-level degree is also accepted; other degrees (MBBS, B.Com, BBA, B.Pharm, LLB…); an explicit
   exclusion of B.Tech/B.E.; any graduation year without 2027. VERIFIED = B.Tech/B.E./Bachelor of Technology|Engineering (or a Bachelor's in
   computer science/engineering/IT) **and** the 2027 batch both stated. A 2027 year alone never verifies. **UNVERIFIED** (degree and/or year not
   stated, nothing excludes): allowed only for a fresher listing on an official board — the same safe handling as undisclosed pay — with the
   note "… not stated: 2027 B.Tech / B.E. eligibility is not verified" and `educationVerified=false`; otherwise uncertain (not saved).
   **Decision for you:** this keeps unstated-degree listings. Requiring explicit B.Tech/B.E.+2027 on every job would cut supply to near zero
   (0 of ~600 full-time listings in the sweep stated both).
2. **Worldwide remote** — `remoteScope()` in `job-eligibility.ts`. India (location names India): remote/hybrid/on-site as before. Anywhere else:
   needs evidence — location says worldwide/anywhere/global, or the text says worldwide / work-from-anywhere, or India is named eligible.
   REJECT: a country/state/region in the location without worldwide/India (US, Canada, UK, EMEA, "Remote (California)"…), "US-only"/"must be located
   in…"/"authorised to work in…"/"work authorisation"/"residents of…" without India. Conflicts (worldwide + US work authorisation) are rejected.
   Plain "Remote" is UNCERTAIN ("does not show applicants in India are eligible"). Company HQ is never consulted. The reason is stored in the
   funnel counts and in the saved job's note ("worldwide remote: …"). Non-India pay uses the remote thresholds (INR-equivalent).
3. **Recency by ORIGINAL posting date** — `job-recency.ts`: windows 0–7, 8–15, 16–30, 31–60, 61–90, 91–120 calendar days in `APP_TIMEZONE`;
   >120 rejected; undated/unparseable/future-dated → uncertain (never "new"). Dates used: Greenhouse `first_published` (NOT `updated_at`, which
   changes on every edit), Lever `createdAt`, Remote OK `date`, Arbeitnow `created_at`.
4. Unchanged: 13 role families (unsure titles rejected up front), no CGPA/backlog rule, ₹30k/₹50k stipends, ₹10 LPA, paid portals, 15+15 targets,
   5 per member (round-robin). New: when one non-India group is empty, US+OTHER share a combined allowance of 10 (India stays 5).

### Progressive search over the REMAINING quota (`runDailyJobSearch`)
Per kind and local day, state in NF_State (`<day>#funnel-<kind>`: window `w`, sweep counter `n`, scans, cumulative funnel + per-window counts).
Window 1 is open from the start of the day; only open windows are allocated, newest first (recency dominates tier and skill fit in the rank).
After a full sweep of the board list (≈ ⌈boards/12⌉ scans) with the quota still unmet, the next-older window opens. A kind whose total is reached
is not searched at all (the other continues alone) — examples A/B/C and "no starvation" are integration tests. Each save bumps the ledger as it
happens, and the scan count/window/funnel are written in a `finally`, so an interrupted run neither repeats nor loses progress. The board slice is
a persisted counter, so a sweep survives restarts. Duplicates: same job from two sources counts once (official wins); jobs already in Jobs are
never re-allocated. Resets at local midnight (day-keyed).

### Diagnosis (before): what the pipeline did
Sources return Greenhouse (list incl. `first_published`), Lever, Remote OK, Arbeitnow (all with posting dates); degree/year came only from
`graduationYears()` (no degree rule existed); "Remote" + a US/other country was accepted as remote (no worldwide check); recency was ignored;
quotas were per day with no window concept; duplicates by URL/company+title against the Jobs sheet. Counters reset correctly (day-keyed). No
cursor/throttle blocked searching since #12–#15 (Sheets 429s still occur; calls are 200). The two kinds could starve each other until #13.

### Tests (1 Nov)
typecheck + lint clean; **1,182 vitest passing (72 files)** incl. `job-rules-2027.test.ts` (education, remote, exact window boundaries, tz edge,
undated), `progressive-windows.test.ts` (A/B/C, exhaustion, shortfall, duplicates, restart, no starvation, empty profile), updated daily-jobs tests;
live run on the **disposable test spreadsheet** (`tests/live/job-windows.live.test.ts`, 1/1 pass: cursor + funnel persisted across fresh "processes",
15 jobs, 5/5/5, no duplicate links). The live test needed an `NF_State` tab on the TEST sheet (added there only). Production was not read by that
test. NOTE: Sheets read quota (60/min) is project-wide and shared with production; two earlier live runs hit it.

### Production results
**Production (deployments `h8nCXb`, `uumrtW`; all cron calls 200, no 504/409 since #15):**
- Window cursor works in Production: window 1 open from the start of the day, **window 2 opened after the 9th scan (06:30 UTC)**, and the cursor survived the next deploy (still window 2 on `uumrtW`).
- Counts for 7 scans of `h8nCXb` (05:40–06:25 UTC, window 1 only), by category — *discovered ≠ saved*:
  | stage | internships | full-time |
  |---|---:|---:|
  | listings on boards read (84 board reads) | — | — |
  | discovered after prefilter | 151 | 2,698 |
  | parsed (valid, this kind, unique) | 150 | 2,631 |
  | rejected | 95 | 2,068 |
  | uncertain (not saved) | 54 | 560 |
  | eligible | 1 (window 6) | 3 (window 1: 2, window 2: 1) |
  | deferred (older window not open yet) | 1 | 1 |
  | duplicates (already in Jobs) | 0 | 2 |
  | allocated / **saved** | 0 / **0** | 0 / **0** |
- Day totals so far (NF_State, 1 Nov IST ≈ 12:15): **saved 1 internship + 3 full-time**; the Jobs tab read through the All Jobs service shows exactly the same
  rows for 1 Nov (internship: Anni 1; full-time: Anni 1, Lukky 1, Rishii 1). 15 + 15 was **not** reached.
- 31 Oct: the funnel counter says 1 internship + 6 full-time saved, the sheet holds 4 full-time + 0 internships stamped "on 2026-10-31" — 3 rows fewer
  than the counter (consistent with members deleting jobs; **not investigated / not verified**).
- Real-source end-to-end run (public boards → real pipeline → in-memory sheet, all six windows opened, fake devices): **2 internships + 3 full-time
  real listings saved** (Celonis, HackerRank, Stripe ×2, Sumo Logic), all five visible in All Jobs to all three members, **10 notifications = 2 per job**.
  Funnel of that run — internships: 213 discovered → 212 parsed → 135 rejected, 75 uncertain → 2 eligible → 2 saved; full-time: 3,783 → 3,695 → 2,953
  rejected, 738 uncertain → 4 eligible (1 duplicate) → 3 saved. Education was "not verified" for all five (no listing states B.Tech/B.E. + 2027).
- Why so few: under these rules only ~2–5 listings per sweep of 106 Greenhouse boards qualify (top reasons: pay not disclosed / not an explicit fresher
  listing, US/other remote not worldwide, "Remote" without India eligibility, role not a target family, unstated degree on non-fresher listings).


### Still open
- Supply under the new rules is far below 15+15/day (see results). Levers: more official boards (Greenhouse tokens are cheap; Lever/Ashby gave none/are
  robots-blocked), accepting plain-"Remote" listings whose description is silent (rejected today as unknown), APAC/Asia-wide wording, a permitted LinkedIn route.
- 2 of 106 seeded boards return nothing each scan (dead tokens); "Connections: 3 row issue(s)" still logged each call.

---

## 🔄 UPDATE 2026-11-01 (supersedes everything below where they differ)

**Production:** `main` @ `b3d1555` (PRs #12 `0dc98cd`, #13 `93c3476`, #14 `07dd719`, #15 `b3d1555`) — deployment Ready, built from that
merge commit [VERIFIED via GitHub deployment record]. Cron-job.org schedule unchanged (every 5 min, 200s in logs).

### 1. Connection discovery is OFF
`NETWORK_FINDER_CONNECTION_DISCOVERY` (default **off**, not set in Prod). `runBatchTick` returns `discovery_off` before reading
Sheets. No company/people discovery, no automatic connections. Existing connections/data untouched; manual Connections page,
Gmail drafting, sent tracking and the daily job search all still run. Re-enable only with `NETWORK_FINDER_CONNECTION_DISCOVERY=true`.

### 2. Gmail drafts — root cause and fix
- **Root cause:** the draft never read the connection's description. The role came from (a) the company's row in the Jobs sheet,
  (b) the company's careers board, else (c) the default template = **Software Engineer**. The person's *designation* was the only
  connection field passed, and Notes were ignored. Tests passed because they supplied a Jobs row.
- **Fix:** `connection-role.ts` reads the role from **Notes** (then "Message to send"): `Role: X`, `Position:`, `Job title:`,
  `Hiring for X – focus`, `X Intern`, any labelled title (not tied to engineer-style words). Focus after a dash/parenthesis
  (“Video Generation”, “Payments”) is kept and must appear in the email. Two different roles → ambiguous. Missing/ambiguous →
  **neutral enquiry** (no role, no skills, never Software Engineer), ledger detail `review: …`. The Notes placeholder now says
  `Role: …`. Company website + careers board are researched; a board opening with the same role supplies requirements.
  Only each member's verified skills/projects are used; Rishi (no verified profile) gets role-specific emails with no skill claims.
- **Duplicates/status:** unchanged ledger (`created`/`sent` never recreated; failed retried; disconnected Gmail skipped once, others
  unaffected). New: a connection whose last attempt failed sorts behind never-tried ones (no head-of-line blocking).
- **Tests** (`manual-connection-role-drafts.test.ts`, `connection-role.test.ts`): Magic Hour AI (Machine Learning Engineer – Video
  Generation), Learnosphere (Full Stack Developer Intern), Alehar (Technology, Data & AI Internship), backend, data engineering →
  15 drafts, each member's own name/links, bodies differ per member and per role, no “Software Engineer”, designation not mistaken
  for the role; neutral/ambiguous cases; retries; disconnected mailbox; discovery-off. **[NOT VERIFIED IN PROD]**: no real manual
  connection has been drafted by the new code yet (I did not create production data). Next real manual connection: put
  `Role: <title>` in Notes and check the three drafts.

### 3. Job discovery — where jobs were lost (real numbers)
Production NF_State (read-only, counts): **28 Oct** 5 internships + 5 full-time; **29 Oct and 30 Oct: 0 saved** (12 and 7 hourly
searches ran); **31 Oct before the fix: no search started at all**. Causes, in order of impact:
1. **Supply = 5 companies.** The search read only boards of companies in NF_Companies (5 rows, 4 of them `no_contacts`) plus Remote OK
   / Arbeitnow. Strict filters + dedupe left nothing. → 106 official Greenhouse boards seeded (`src/config/job-boards.ts`),
   independent of people discovery; each scan reads a rotating slice (12 boards), full sweep ≈ 1 h.
2. **The search ran last** and was skipped whenever drafts/sent tracking/batch used up the 50 s budget (Sheets 429s). → order is now
   drafts → jobs → sent tracking → re-checks; one drafting pass; batch step returns instantly.
3. **The hourly key was written before searching** — a run killed mid-search burned the hour. → throttle removed.
4. **Jobs sheet read on every scan** → only when something qualifies. Quiet cycle ≈ 9 Sheets reads (test guards ≤ 12, ≤ 2 per tab).
5. **Ashby boards never worked**: `api.ashbyhq.com` robots.txt disallows automated access and the app (correctly) honours it. 28
   candidate Ashby boards removed. SmartRecruiters is also robots-disallowed. LinkedIn: not automated (terms) — unchanged.
6. **Second kind starved**: the full-time pass could not use boards the internship pass had listed (found from live logs, fixed #13).
7. **Same unplaceable titles allocated every scan** (“Renewals Associate”…): allocated 147 vs saved 6 on 31 Oct → rejected once up front.
8. **Level-one titles** (“Software Engineer I”, SDE-1) now count as fresher-friendly; matcher bug fixed (“Senior … I/II” was “junior”).
9. **Allocation** is round-robin across members (was greedy: all scarce jobs went to Aniket); still 5 per member / 5 per country group.
10. **504s** (≈1 in 4 calls): run budget 50→44 s and the endpoint now answers 200 at 55 s (`timedOut:true`) instead of being killed.

**Funnel is now persistent** (NF_State rows `note:<day>#funnel-internship|full-time`) and logged per call (`[daily-jobs]`, counts only):
boards read/failed → listed → discovered → parsed → rejected/uncertain → eligible → duplicates → allocated → saved, plus top reasons
(including `released: …`). Sheet check at ~09:40 IST on 1 Nov: **saved so far today 1 internship + 3 full-time; 31 Oct 1 internship +
6 full-time**.

**The honest shortfall (rules unchanged — the quota never lowers the bar):** full-time, 1 Nov, ~69k listings seen across scans →
246 eligible; top rejections: pay not disclosed + not an explicit-fresher listing (~36k), “does not say freshers/2027 batch” (~36k),
role not suitable (~27k), US/other remote not stated (~23k), country unclear (~10k). Internships: 4.8k parsed, 96 eligible; most US
internships are on-site (rejected by the remote-only rule). A live sweep of all boards at one moment gave ≈ 7 internships and ≈ 23
full-time eligible (before the title fixes) — i.e. **15+15/day is not reachable from official Greenhouse boards alone under these
rules**. Levers (need your decision): more boards (Lever/Greenhouse tokens are cheap to add), accepting “pay not disclosed” for
non-explicit-fresher official listings, or a permitted LinkedIn route.

### 4. Tests (all run 1 Nov)
typecheck + lint clean; **1,152 vitest passing (70 files)**; Playwright isolated `connections.spec.ts` desktop+mobile 6/6; live
Network-Finder suite vs the disposable test sheet: 12/13 (HN source returned an empty body — external, discovery is off); the generic
`test:live` run hit Google's **60 reads/min/user quota, which Production shares** (my run briefly competed with the cron — don't repeat
while the cron runs). Live public-source sweeps and read-only forensic reads wrote nothing.

### 5. Still needs verification
- A real manual connection drafted by the new code in all three Gmails (see §2).
- 504 rate over a longer window (last sample on `SKsYBq`: 2 calls, both 200).
- “Connections: 3 row issue(s) while reading” appears every call — 3 Connections rows fail validation and are skipped (unrelated; inspect which).
- Sheets 429 retries still occur (quota is project-wide); further read reductions possible (NF_State full-tab fresh read).
- Rishi's profile is still empty (low skill matches; no-claim emails).

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
**Eligibility is member-independent**: a member's verified skills only RANK job/member pairs and add a note ("low skill
match" when insufficient); an empty/partial profile never excludes anyone, so 5/5/5 works for all three. Rishii's
profile is still empty, so his jobs are low skill matches and his emails make no skill claims. Env `NETWORK_FINDER_DAILY_INTERNSHIPS/FULL_TIME` default 15 (not set in Prod).

**Drafts now:** `company-research.ts` reads the company's OWN site (meta description, verbatim) and careers board; each
member is pointed at the real opening that fits their verified skills (`pickJobForMember`); no verifiable opening →
role-family email, no invented job. Validation rejects wrong role, missing role/company, other member's identity,
unverified skills, invented company facts/familiarity, generic text that ignores the company/job. NF companies' jobs are
now saved BEFORE their contacts' drafts. Tests: `network-finder-personalised-drafts.test.ts`.

---

**Final state of 28 Oct:** PR #9 (`c0dd859`, merge `03f13f2`) = stall fix + company-specific drafts + 15/day jobs;
PR #10 (`22c486b`, merge `700a87b`) = eligibility identical for every member (skills only rank). Both live.
Tests: typecheck + lint clean, **1,127 vitest passing (67 files)**; Playwright isolated connections+profile 48 passed / 10
skipped (run for PR #9, no UI change since). Post-deploy: cron calls return 200 (no 504/409).

**Decisions to remember:** "15/day" was read as 15 PER KIND (internship and full-time) = up to 30/day — unconfirmed by the
user (set `NETWORK_FINDER_DAILY_*` to 8/7 for 15 total). LinkedIn stays unautomated. Never loosen filters to fill quota.
Rishii's profile is empty (low skill matches, no-claims emails) until his resume facts are added to `member-email-profiles.ts`.

**Next session, in order:**
1. Read this file. One read only of the prod sheet (no polling): check `Jobs` for rows "Found by Network Finder" today,
   per-member counts, and NF_State `ledger:…#jobs-*` keys; confirm eligible jobs really land.
2. Check Vercel logs (1 h retention only) for `/api/cron/network-finder` status codes in an active window.
3. Sheets 429s still occur after the fix (calls end 200 but retry a lot). Untriaged: likely NF cycle full-table
   `fresh: true` reads. Consider caching/reducing reads per cycle.
4. Supply of companies is thin (HN + remoteintech only, ~5/day). New permitted sources needed for 50/day.
5. Do not touch cron-job.org unless proven wrong.

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
| Production deployment | **`main` @ `700a87b`** (PR #10) — `jobsbyarillabs-k32r9sqbt-iamankoos-projects.vercel.app` — **Ready** [VERIFIED ~20:50 IST]. (Older table rows below are from 03:20 IST.) |
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
| Handoff summary docs | `ae0cd39` | #8 | `aed4d0a` |
| Stall fix (retry deadline, lock TTL, deadline-aware discovery), company-specific drafts, strict 15/day jobs | `c0dd859` | #9 | `03f13f2` |
| Eligibility identical for every member; skills only rank | `22c486b` | #10 | `700a87b` |

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
