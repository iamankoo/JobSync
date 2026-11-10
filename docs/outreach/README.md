# Outreach: Outreach Database -> Connections -> drafts -> (gated) sending

**Status: deployed. Nothing runs unless the outreach cron is explicitly enabled.** The code-level sending switch
(`SENDING_ENABLED` in `src/lib/outreach/types.ts`) is open, but the cron endpoint answers 503 until `OUTREACH_ENABLED=true`,
`OUTREACH_CRON_SECRET` and `OUTREACH_SPREADSHEET_ID` are set, and every send must still pass all 14 checks, the limits and (when set)
the recipient allowlist. Setting `SENDING_ENABLED` back to `false` and deploying disables all sending at once.

## 1. Workflow

```
Outreach Database (Google Sheet, separate file from the production JobSync Database)
  Master Contacts            15,891 contacts (read-only here; never edited or deleted)
  Added in Outreach Emails   one row per contact in the pipeline (imported OR manual) - tracking + status
  Outreach Send Ledger       durable idempotency + history of every send attempt (one active row per recipient)
  Outreach Exclusions        opt-outs, by e-mail or domain (maintained by hand)
  Outreach Daily Counters    derived daily figures
  Outreach State             run lock

cron  GET /api/cron/outreach   (Bearer OUTREACH_CRON_SECRET; OFF unless OUTREACH_ENABLED=true)
  1. register manual Connections into the tracking tab          (same pipeline as imports)
  2. import <=200/day, <=10/call, one at a time, into Connections (existing createConnection service)
  3. draft: the existing worker (runPendingDrafts) creates one Gmail DRAFT per member, in that member's OWN mailbox,
     with that member's OWN resume attached and read back
  4. sync statuses from the draft ledger
  5. SEND (behind the compile-time gate; a no-op today): validate 14 checks, claim, send the OWNER's verified draft, confirm
  6. sync again, recompute counters (derived from confirmed rows only)
```

Manual Connections added by Aniket, Lakshya or Rishi and imported contacts are the same kind of record (a Connection) and take
exactly the same path from step 3 on. A contact is identified by its normalised e-mail; whoever got there first owns the tracking row.

### Import (steps 1-2)
At most 200 **shared Connections globally per rolling 24 hours** (`OUTREACH_DAILY_LIMIT`, can only be lowered; all three members together, not 200 each), 10 per call. Per contact: write a tracking row
`importing` and read it back; re-check Connections; create the Connection; mark the row `added` **only after** the Connection was
saved. A crash between the last two steps is repaired by the next call (it finds the Connection by e-mail). Imported Connections are
owned round-robin by the three members. Eligible = valid e-mail with matching ContactID, not a legacy-ISP address, not an investor
entry, mappable role, first member of a possible-duplicate group. PersonName / CompanyName are never overwritten; message text uses
**Hiring Team** and **your company** when a name is missing (Connections requires a name, so a nameless contact is stored there as
"Hiring Team"; a missing company stays empty and is never researched).

## 2. Sending eligibility (all 14 must pass; the first failure blocks and is recorded as `[check_id] reason`)

| # | Check (`id`) | Blocks as |
|---|---|---|
| 1 | valid recipient address (`valid_email`) | blocked |
| 2 | eligible for outreach, still in the Outreach Database (`eligible`) | blocked |
| 3 | has a Connection, still "Not Connected" (`connection`) | blocked |
| 4 | the sending member is a known member (each member sends from their OWN account) (`owner`) | blocked |
| 5 | the owner's Gmail identity is connected (`member_identity`) | waits / auth |
| 6 | a personalised draft exists in the OWNER's mailbox (`email_generated`) | waits |
| 7 | the saved draft is supported: greeting (person or Hiring Team), company in the body (or "your company"), the target role stated as a phrase, the owner's signature, no unresolved placeholder, nothing about another member (`content_supported`) | **review** |
| 8 | body within the 150-word limit (`word_limit`) | **review** |
| 9 | recipient has not already received outreach: no other member sent it by hand, no other record of this address was sent (`not_already_received`) | blocked |
| 10 | not opted out or excluded (`not_excluded`) | blocked |
| 11 | no previous successful send for this contact/recipient (`no_prior_send`) | blocked |
| 12 | the owner's resume is available and the draft carries exactly that file: one attachment, the expected name, the expected size (`resume`) | **review** |
| 13 | Gmail authorisation valid (the draft can be read back with the owner's token) (`gmail_auth`) | auth |
| 14 | Gmail has not asked this member's account to slow down (`gmail_quota`): after a Gmail quota/rate-limit refusal that account waits out a growing cool-down (15, 30, 60 ... up to 240 min); other members keep sending. There is no JobSync sending cap. | waits |

Checks 7, 8, 12 run on the **real saved Gmail draft** read back with `drafts.get`, not on what was intended. Checks run cheapest first;
Gmail is read only after every local check passed.

## 3. Outcomes

- **A. Everything passes** -> claim -> record `sending` -> `drafts.send` -> only a response with a message id **and** the `SENT` label
  counts as sent -> ledger `sent` (message id, resume file + SHA-256, Gmail address used, word count, IST day), tracking `sent`, the
  owner's draft ledger row `sent`, the Connection becomes "Messaged". Counters rise only now.
- **B. Resume unavailable** (no SDE fallback either, ambiguous, unreadable, or the draft's attachment is not that file) -> **not sent**;
  the draft stays (created without an attachment and flagged `review:` by the drafting step); tracking `review`.
- **C. Personalisation / validation failure** -> not sent; the exact reasons are in `SendBlockReason`; the draft stays; `review`.
- **D. Gmail auth / quota / API failure** -> nothing counted; `failed_transient` with a retry time (rate limit: >=15 min or the
  `Retry-After`; auth: 1 h; transient: 10 min); at most 3 attempts, then manual review; a permanent rejection (400) is `failed_permanent`
  and never retried. A rate limit stops the run; an auth failure marks that member's Gmail "needs re-authorisation" and holds their
  other contacts.
- **E. Uncertain result** (timeout/network error after submitting, 5xx, 2xx without a `SENT` message id, "draft not found" after the
  request) -> **never retried blindly**. Reconciled against Gmail: draft still there -> not sent (retry after back-off); draft gone and
  the thread shows a `SENT` message -> recorded as sent (message id from Gmail); otherwise -> `uncertain` + manual review, and it is
  re-checked on later runs but never re-sent. Reconciliation of a vanished draft needs the optional **metadata** permission
  (`GMAIL_TRACK_SENT=true` and members re-consenting); without it an uncertain send always ends in manual review.

## 4. Draft fallback behaviour
Drafts are always created by the existing worker (one per member). Unresolved resume or validation problems leave the draft in place
with a `review:` flag; automation never sends a flagged draft. **Each member's own** draft is auto-sent from that member's own Gmail (one Connection = three separately personalised e-mails, sent only after that member's draft passes all checks). Previously only the owner's was sent; the next sentence is historical: the two other
members' drafts for the same contact stay as drafts: they must not be sent by hand once the owner's was (the tracking tab shows
`SentBy`, and check 9 blocks automation if a member sent theirs).

## 5. Resumes (all three members; own files only)
Role -> kind -> that member's own exact file name (`src/config/resume-map.ts`):

| Target role | Kind | Aniket | Lakshya | Rishi |
|---|---|---|---|---|
| AI / ML / AI Engineer | AIML | `Aniket-Raj-AIML.pdf` | `Lakshya_AiMl.pdf` | `Rishi_Raj_AIML.pdf` |
| Software / SDE / Backend / Python / App / custom | SDE | `Aniket_Raj_SDE.pdf` | `Lakshya_SDE.pdf` | `Rishi_Raj_SDE.pdf` |
| Front End / Full Stack / Web / MERN | WebD | `Aniket_Raj_WebD.pdf` | *(not uploaded -> own SDE)* | *(not uploaded -> own SDE)* |
| DevOps / SRE | DevOps | `Aniket_Raj_DevOps.pdf` | *(-> own SDE)* | *(-> own SDE)* |
| Data Engineer / Scientist / Analyst | Data | `Aniket_Raj_Data.pdf` | *(-> own SDE)* | *(-> own SDE)* |

Every read is scoped to the member id, files are matched by exact name, must be a single unambiguous PDF with a `%PDF-` header. The
send step re-resolves the resume and compares **name and byte size** with the attachment read back from the saved draft (Gmail's
`gmail.compose` scope cannot download attachment bytes, so size + name + the bytes JobSync itself attached are the strongest check
available; the file's SHA-256 is recorded in the ledger).

## 6. Retry and duplicate protection (Sheets has no transactions - this is how it is made safe anyway)
Per recipient e-mail (`SendKey`) the Send Ledger is an append-ordered claim log (`send-ledger.ts`):
1. If a row for the key is already `claimed`/`sending`/`sent`/`uncertain`, or `needs_review`/`failed_permanent`: do not send.
2. Append a `claimed` row with a unique ClaimID and read it back (the row is located by ClaimID, not by an assumed row number).
3. Re-read: the **first live row wins**. Appends are totally ordered by Sheets, so concurrent cron executions all see the same winner;
   losers mark their row `superseded` and do not send. (Tested with eight simultaneous claimants.)
4. The winner writes `sending` **before** calling Gmail and the final status after. A crash in between leaves `sending`, which is
   reconciled against Gmail on the next run (after 2 minutes), never retried.
5. A `claimed` row that never reached `sending` is released after 10 minutes (no request was made).
The run lock (`Outreach State`) and the NF run lock around drafting add a second layer. Imported and manual records share all of this
because the key is the normalised e-mail, not the source. Draft retries use the existing draft ledger (one draft per connection per
mailbox). A successful send is never repeated by a retry; a failed operation is never recorded as success (rows change only after the
write succeeded; derived counters ignore attempts).

## 7. Counters and history
`Outreach Daily Counters` (one row per IST day) and the tracking/ledger tabs. Counters are **derived from confirmed rows**:
imported today, added to Connections, emails drafted, emails sent (automated sends only: ledger `sent` with Gmail's message id), sent today and per
member, awaiting, requiring review, failed processing, failed sends, skipped (blocked) contacts, duplicates prevented (linked to an
existing Connection, manual-first, lost claim races), queue remaining. The ledger keeps for every attempt: ContactID, normalised
recipient, company, role, member, Gmail address used, status, Gmail message id, resume file + SHA-256 + size, word count, attempts,
back-off time, reason and a compact retry/reconciliation history. **No OAuth tokens, passwords or message bodies are stored in Sheets or
logs**; the Gmail address is stored because it identifies which mailbox sent.

## 7b. The Sent counter on the Gmail drafts page
The page shows **Draft** and, directly to its right, **Sent** (same card style, centred together at every width). Both are live:
the page asks `GET /api/gmail/counters` as soon as it loads, then every 15 s while the tab is visible and on focus; the whole page also
re-fetches every 30 s. The endpoint only reads ledgers: it makes no Gmail call.

**Sent counts ONLY e-mails sent by JobSync's automated sending workflow.** A recipient counts (once, per member) when all of these hold:
JobSync itself called the Gmail send API; Gmail confirmed success (a message id and the `SENT` label, or - after an uncertain result - the
workflow's own reconciliation found that exact message); the Outreach Send Ledger recorded the result with status `sent`; and the ledger
row carries Gmail's **message id**. The same rule drives `EmailsSent` / `SentToday` in `Outreach Daily Counters`.

**Never counted:** drafts; claimed, sending, pending, failed, uncertain, superseded, released or review rows; a JobSync draft that a member
sends by hand from Gmail; any e-mail sent outside JobSync. The draft ledger and Gmail's Sent folder are **not** a source for this counter,
and `GMAIL_TRACK_SENT=true` does not change that (that setting only lets the existing sent-draft tracker update draft statuses and
Connection statuses, and lets the send workflow reconcile an *uncertain automated* send). Duplicate protection: the ledger key is the
normalised recipient address, so a send mirrored in other JobSync records (draft ledger, Connection "Messaged", tracking tab) or repeated in
several ledger rows is counted once.

**Draft is unchanged:** JobSync drafts still waiting in the member's Gmail. A draft stops counting as a draft once it is sent, whether by
JobSync (then it also counts as Sent) or by hand (then it counts as neither; the table row still shows the existing "Sent" badge).

**Permissions:** a member's counts are computed from that member's own rows. `?member=` is honoured only for the administrator (Anni);
anyone else asking for another member gets 403, unknown members 400, signed-out requests 401.

## 7c. Milestone notifications to all three members
Raised by the outreach cron cycle (never by a member), delivered as ordinary Web Push to **every registered device of all three members**
through the same delivery code as the existing notifications (`lib/push/notify.ts`): only devices a member has opted in on (their saved
subscriptions) receive anything, one browser registered for several members gets it once, expired devices are removed, nothing is sent
when push (VAPID) is not configured. JobSync has no per-event mute settings today, so per-device opt-in is the preference model.

| Notification | Milestones | Counts | Opens |
|---|---|---|---|
| **"10 connections added"** | 10, 20, 30, 40, 50, ... | Connections JobSync's Outreach Database import **successfully created** | `/connections` |
| **"10 emails sent"** | 10, 20, 30, 40, 50, ... | **confirmed automated sends** (Send Ledger `sent` + Gmail message id, each recipient once) | `/gmail` |

The two have independent counters and independent milestones. There is **no** per-Connection and **no** per-email notification (the earlier
"Connection added by JobSync" notification was retired and its code removed). **Not counted toward "connections added":** Connections members
add by hand, contacts that were already in Connections (linked or duplicates), failed or unfinished imports, skipped/ineligible contacts.
A Connection deleted later still counts (JobSync did create it).

**Exactly once.** Each milestone is *claimed* in the `Outreach State` tab before delivery (key `milestone:<kind>:<N>`): an ordered append
whose first row wins, so overlapping executions and cron retries cannot both announce it; after delivery the row becomes `done:<id>`
(the durable record). If the devices cannot be reached the claim is released and the next pass delivers it (nothing lost, nothing repeated);
if the process dies mid-way the unfinished claim goes stale after 10 minutes and is retried (a rare repeat is collapsed on the device by
the notification tag). A progress row `connections-announced` / `emails-announced` shows the highest milestone delivered.

**Unchanged:** a Connection a member adds by hand still notifies the OTHER two members ("<name> added a connection: ..."); Network Finder
summaries, jobs, applications, chat, calls and the scheduled messages behave exactly as before.

## 8. Cron configuration and limits
`OUTREACH_SPREADSHEET_ID`, `OUTREACH_CRON_SECRET`, `OUTREACH_ENABLED` (default false). Independent limits:

| Setting | Default | Ceiling | Meaning |
|---|---|---|---|
| `OUTREACH_DAILY_LIMIT` | 200 | 200 | shared Connections **imported** per rolling 24 h, all members together |
| `OUTREACH_IMPORT_PER_RUN` | 10 | 50 | contacts imported per cron call |
| `OUTREACH_DRAFTS_PER_RUN` | 2 | 10 | contacts drafted per cron call |
| `OUTREACH_MASTER_TAB` | `Master Contacts` | plain tab name | the tab contacts are read from (a separate tab lets a controlled test use its own contacts) |
| `OUTREACH_OWNER` | unset (round-robin) | a member id | every imported Connection is owned by this member, so it is sent from that member's Gmail |
| `OUTREACH_SEND_ONLY_TO` | unset (no allowlist) | - | comma-separated recipients that are the ONLY ones ever sent to; exact addresses or `local+jobsync*@domain` (hard safety net for tests) |
| `OUTREACH_MANUAL_SINCE` | unset | ISO time | Connections members added by hand before this instant are ignored by the pipeline (so existing Connections are never auto-sent) |

Values above a ceiling, negative, fractional or non-numeric are ignored (the default applies).

**Sending has no JobSync cap.** The old `OUTREACH_SEND_PER_MEMBER_DAILY` (200), `OUTREACH_SEND_GLOBAL_DAILY` (600) and `OUTREACH_SEND_PER_RUN` (10) settings
were removed and are ignored if still set. Every eligible e-mail is sent until the queue is drained: a call sends as many as its time budget allows
(20 s, or 28 s while drafting is paused by the backlog gate) and the next cron call continues. What still slows sending is genuine: Gmail's own quotas
and rate limits (a refused account pauses with a growing cool-down, never blindly retried; refusals do not use up a recipient's attempts), the
execution time budget, and the safety checks. The only numerical limit left is the **import** limit above (200 Connections from the Outreach
Database per rolling 24 h, global); manually added Connections never use it up. To stop everything immediately, unset `OUTREACH_ENABLED`.

**Draft backlog protection.** While 100 or more JobSync-generated drafts are sitting unsent in the three members' Gmail Drafts folders, no new
draft is created anywhere (Outreach and Network Finder share one gate, checked once before a Connection's three-member fan-out). The count is of
real Gmail drafts: one paged `drafts.list` per member (ids only), intersected with the draft ledger (`NF_Drafts`, status `created`); drafts that
were sent or deleted, and drafts the members wrote themselves, are not counted. Existing (old) drafts count exactly like new ones: there is no
creation-date cutoff. The count is of the ELIGIBLE backlog: a draft that needs a person (flagged `review:` when drafted, or `parked:` by the send step,
see below) stays in Gmail untouched but is reported separately as `parked`, so drafts only a person can fix cannot pause drafting for ever.
If the count cannot be obtained, drafting pauses (fail closed). Sending is never gated and drains the backlog; drafting resumes by itself below 100.

**Draining every existing JobSync draft (no creation-date cutoff).** The send step works from the tracking tab, so a draft whose Connection had no
tracking row (Network Finder drafts, manual Connections older than 30 days, drafts skipped by earlier runs) used to wait for ever. Each cron call now
first registers (source `existing-draft`, at most 40 per call, oldest first) every Connection that still has an unsent JobSync draft in the draft
ledger, however old; the normal send step then decides each member's draft on its merits, after reconciling any older uncertain send against Gmail:
- eligible, in the intended member's own Gmail, with that member's own resume attached and verified -> sent and recorded in the Send Ledger with
  Gmail's message id (the draft is then marked sent, and a durable ledger row makes a second send impossible);
- missing / wrong / unreadable resume, failed content check, opted out, invalid recipient, duplicate recipient, Connection gone, Connection no longer
  "Not Connected"/"Messaged" -> never sent, never edited or deleted in Gmail; the reason is recorded in the tracking row and as a `parked:` note on the
  draft's ledger row (NF_Drafts.Detail). The note is lifted automatically when the reason goes away (e.g. the opt-out is removed);
- an uncertain earlier send -> reconciled against Gmail first, never resent while unresolved (and not parked: it is still an unresolved pending draft).
Drafts that are not in the draft ledger (anything a member wrote by hand) are never read, counted, sent or touched. The drafting worker never writes
a second draft for a recipient who already has an unsent or sent draft from that member, on any Connection (also within one run).
Drafts already recorded as unsendable are re-checked last each call, so they can never use up the time slice eligible drafts need. Processing continues on
every cron call until every eligible draft is sent.
The cron log shows `drafts.paused` with the reason. Master Contacts is never read for the count.
Logs: one `[outreach]` line per call with counts and statuses only (no names, addresses, companies or tokens).

### Priority contacts (import some contacts before the rest of the Outreach Database)
An optional tab **Priority Contacts** in the Outreach Database (same columns as Master Contacts; not created automatically, so nothing changes until it exists)
is a queue that the importer works through BEFORE the rest of Master Contacts, in sheet order. A row is either a full contact row (a contact that is not in
Master Contacts) or an ID-only row (only `ContactID`), which promotes an existing Master Contacts row. Master Contacts is never edited and nothing is
renumbered: ContactIDs are derived from the e-mail, de-duplication by ContactID / e-mail (tracking, Connections, the other tab) is unchanged, so no contact
can be imported twice. Priority contacts are ordinary database imports: they are counted by, and limited by, the 200-per-rolling-24-hours import limit
(the position in the queue is not a limit), they are eligible to send on the same rules as Master contacts, and they follow the shared-Connection workflow
(three personalised e-mails, each from its member's own Gmail with that member's resume) and every opt-out / duplicate / quota safeguard.
`scripts/outreach/priority-contacts.mts` builds the tab from a contact list: a DRY RUN by default (read-only; writes only report files), and `--apply` only
together with `--i-have-owner-approval`; it refuses the production spreadsheet and a tab that already holds rows. The cron log shows `priorityLeft`.

### Who still has an e-mail to send (per member, never per contact)
One shared Connection produces up to three e-mails, one per member, and a member's draft can appear at any time (for example after their Gmail was
reconnected). Whether a member still has work is therefore decided for THAT member from the two durable ledgers: the draft ledger (an unsent draft
exists) and the send ledger (no confirmed send for that member and recipient). The contact-level `sent` flag is only a summary: it is set only when every
connected member's draft is sent, it is never used to skip a member, and a contact flagged `sent` that still has an unsent draft (production had 153 such
contacts) is picked up again. A confirmed send is never repeated (the send ledger), uncertain sends are reconciled first, and every check (member's own Gmail
and resume, opt-out, recipient, duplicates) applies to a late draft exactly as to any other.

### Sheets request budget
Google Sheets allows about 60 reads per minute per user for the whole app. The outreach cycle stays inside that by: remembering each member's Gmail access
(account row + token) for 90 seconds (it used to read the accounts tab and refresh an OAuth token on every Gmail call); loading a resume's bytes once per
file (they were downloaded from the ChatFiles tab for every check); parsing the cached Master grid once (it was parsed three times a cycle) and computing the
eligible-contact set once per cached grid; skipping Master and Connections entirely when the 24-hour import allowance is used up; letting the bookkeeping read
of the draft ledger be up to 20 s old; reusing the ledger read the claim protocol has just made (no second read after a confirmed send); and re-checking
contacts that need a person (marked "review" or "blocked", or all of whose open drafts are recorded as unsendable) only about every 30 minutes (every 15th call,
rotated by contact; the others are always looked at first), so hundreds of them cannot use up every call's time. A disconnect made by another server instance reaches an instance that holds a cached token
within 90 seconds; the send step re-checks every member's connection status fresh at the start of each call. The import limit and every safety check are unchanged; sending has no JobSync cap.

## 9. Failure recovery
| Symptom | What to do |
|---|---|
| Contact stuck `importing` | nothing: the next call links or retries it (3 attempts, then `import_failed`) |
| `SendStatus = uncertain` | open the member's Gmail Sent folder. If the message is there, set the ledger row to `sent` (add the message id); if not, set it to `failed_transient` with an empty `NotBefore`. Never delete the row. |
| `SendStatus = review` | read `SendBlockReason`, fix the cause (upload the resume, correct the draft in Gmail); the next run re-validates and sends if everything now passes. A ledger row in `needs_review`/`failed_permanent` blocks that address until a person edits its status |
| `failed_permanent` | the address was rejected; correct the Connection's e-mail or leave excluded |
| Member Gmail "needs re-authorisation" | the member reconnects Gmail at /gmail; held contacts resume automatically |
| Opt-out request | add the address or domain to `Outreach Exclusions` (takes effect on the next run) |

## 10. Activation procedure
1. Deploy (done). Nothing changes while `OUTREACH_ENABLED` is unset.
2. **Controlled test first, on labelled contacts only:** put ~10 labelled contacts in a separate tab of the Outreach Database and set
   `OUTREACH_MASTER_TAB` to it, `OUTREACH_OWNER` to the member whose Gmail should send, `OUTREACH_SEND_ONLY_TO` to the test inbox
   (e.g. `me+jobsync*@gmail.com`), `OUTREACH_MANUAL_SINCE` to now, then `OUTREACH_ENABLED=true`,
   `OUTREACH_CRON_SECRET`, `OUTREACH_SPREADSHEET_ID`. Call `GET /api/cron/outreach` (Bearer secret) until the 10 contacts are imported,
   drafted and sent; verify the Connections, drafts, attachments, delivered messages, Sent counter and both milestone notifications.
3. **Clean up** (`tests/live/outreach-test-tool.live.test.ts`, action `cleanup`): deletes the test Connections, Gmail drafts, tracking and
   ledger rows, milestone state and counters, and the test tab. Sent test messages stay in the Sent folder/inbox (delete by hand).
4. **Real activation:** remove `OUTREACH_MASTER_TAB`, `OUTREACH_OWNER` and `OUTREACH_SEND_ONLY_TO`; keep `OUTREACH_MANUAL_SINCE`; set
   `OUTREACH_DAILY_LIMIT=200` (max imports per rolling 24 h; sending has no JobSync cap); create
   the cron-job.org job (every 5-10 minutes, Bearer secret). Watch `SendsNeedingReview`, `FailedSends`, Gmail refusals and bounces daily.
   To stop immediately: unset `OUTREACH_ENABLED`.

## 11. Operational risks
- Two members could still send their own (non-owner) drafts by hand for the same contact; automation cannot edit or remove their drafts.
- Sheets is not transactional: the claim protocol is safe against concurrent crons but a person editing ledger rows by hand can defeat it.
- Without the metadata permission an uncertain send cannot be proven either way and always needs a person.
- Many addresses come from old lists: bounces damage sender reputation. Start slowly; remove bounced addresses via `Outreach Exclusions`.
- A deleted Connection stops further processing of that contact; an already-sent message cannot be recalled.
- Dependency advisories apply to the installed Next.js (16.4.0): see the security note delivered with this change; upgrade to 16.4.5 before any production activation.


## Shared-Connection workflow (live)
One imported contact is ONE shared Connection. The drafting worker writes one personalised draft per member (own name, signature, resume); the
send step sends each member's draft from that member's own Gmail. Idempotency key = `member|recipient` (the same recipient may receive one e-mail
per member, never two from one account). Limits: 200 imported Connections per rolling 24 h (global; manual Connections are not counted); NO JobSync sending cap (only Gmail's own quotas). 100+ unsent drafts in Gmail pause new drafting.
The tracking row is "sent" only when all three e-mails are confirmed; the Connection becomes "Messaged" then. A disconnected member is paused
(`reauth_required`) until they reconnect through the normal OAuth flow; the others keep sending. Each cron call: send first (own time slice), then
import, then drafting; Master Contacts is cached per instance for 20 minutes. Test-artefact removal: `POST /api/cron/outreach-cleanup` (inert unless
`OUTREACH_TEST_CLEANUP_BASE` is set; dry run unless `"dryRun": false`).

## Cron execution model (background work)
`GET /api/cron/outreach` authenticates and answers **202 `{accepted:true}` within milliseconds** (cron-job.org gives up after 30 s). The cycle runs as
Next.js `after()` work, which Vercel keeps alive for the route's `maxDuration` (60 s); nothing relies on an un-awaited promise. Inside: Sheets retry
sleeping stops at 50 s, send runs first (~20 s), then import (~36 s), then drafting (~44 s, skipped for the run after 8 Google 429s), hard stop 55 s.
Overlap is prevented by an ordered-claim run lock (first live claim wins; expires after 65 s, so a killed run never blocks the next call). Progress is
durable and idempotent (claims, send ledger, reconciliation), so the next call simply continues. Results are logged as `[outreach] {...}` (counts only).
Schedule every 1-2 minutes.
