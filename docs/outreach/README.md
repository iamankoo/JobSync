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
At most 200 contacts per IST day (`OUTREACH_DAILY_LIMIT`, can only be lowered), 10 per call. Per contact: write a tracking row
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
| 4 | the tracked owner is the Connection's owner (`owner`) | blocked |
| 5 | the owner's Gmail identity is connected (`member_identity`) | waits / auth |
| 6 | a personalised draft exists in the OWNER's mailbox (`email_generated`) | waits |
| 7 | the saved draft is supported: greeting (person or Hiring Team), company in the body (or "your company"), the target role stated as a phrase, the owner's signature, no unresolved placeholder, nothing about another member (`content_supported`) | **review** |
| 8 | body within the 150-word limit (`word_limit`) | **review** |
| 9 | recipient has not already received outreach: no other member sent it by hand, no other record of this address was sent (`not_already_received`) | blocked |
| 10 | not opted out or excluded (`not_excluded`) | blocked |
| 11 | no previous successful send for this contact/recipient (`no_prior_send`) | blocked |
| 12 | the owner's resume is available and the draft carries exactly that file: one attachment, the expected name, the expected size (`resume`) | **review** |
| 13 | Gmail authorisation valid (the draft can be read back with the owner's token) (`gmail_auth`) | auth |
| 14 | daily/per-run limits not reached (`daily_limit`) | waits |

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
with a `review:` flag; automation never sends a flagged draft. Only the **Connection owner's** draft is ever auto-sent. The two other
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
| `OUTREACH_DAILY_LIMIT` | 200 | 200 | contacts **imported** per IST day |
| `OUTREACH_IMPORT_PER_RUN` | 10 | 50 | contacts imported per cron call |
| `OUTREACH_DRAFTS_PER_RUN` | 2 | 10 | contacts drafted per cron call |
| `OUTREACH_SEND_PER_MEMBER_DAILY` | 10 | 50 | messages per member per IST day |
| `OUTREACH_SEND_GLOBAL_DAILY` | 25 | 100 (and <= 3 x per-member) | messages across all members per IST day |
| `OUTREACH_SEND_PER_RUN` | 3 | 10 | messages per cron execution |
| `OUTREACH_MASTER_TAB` | `Master Contacts` | plain tab name | the tab contacts are read from (a separate tab lets a controlled test use its own contacts) |
| `OUTREACH_OWNER` | unset (round-robin) | a member id | every imported Connection is owned by this member, so it is sent from that member's Gmail |
| `OUTREACH_SEND_ONLY_TO` | unset (no allowlist) | - | comma-separated recipients that are the ONLY ones ever sent to; exact addresses or `local+jobsync*@domain` (hard safety net for tests) |
| `OUTREACH_MANUAL_SINCE` | unset | ISO time | Connections members added by hand before this instant are ignored by the pipeline (so existing Connections are never auto-sent) |

Values above a ceiling, negative, fractional or non-numeric are ignored (the default applies); `0` pauses sending. Unlimited sending is
not expressible. The import limit says nothing about sending: importing/drafting is reversible, sending is not. Usage counts
confirmed **and** in-flight/uncertain sends, so an unresolved send still consumes quota. Gmail's own limits are far higher; the defaults
are deliberately conservative to protect each member's sender reputation. Raise them gradually, one setting at a time.
Logs: one `[outreach]` line per call with counts and statuses only (no names, addresses, companies or tokens).

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
   (e.g. `me+jobsync*@gmail.com`), `OUTREACH_MANUAL_SINCE` to now, `OUTREACH_SEND_PER_RUN=10`, then `OUTREACH_ENABLED=true`,
   `OUTREACH_CRON_SECRET`, `OUTREACH_SPREADSHEET_ID`. Call `GET /api/cron/outreach` (Bearer secret) until the 10 contacts are imported,
   drafted and sent; verify the Connections, drafts, attachments, delivered messages, Sent counter and both milestone notifications.
3. **Clean up** (`tests/live/outreach-test-tool.live.test.ts`, action `cleanup`): deletes the test Connections, Gmail drafts, tracking and
   ledger rows, milestone state and counters, and the test tab. Sent test messages stay in the Sent folder/inbox (delete by hand).
4. **Real activation:** remove `OUTREACH_MASTER_TAB`, `OUTREACH_OWNER` and `OUTREACH_SEND_ONLY_TO`; keep `OUTREACH_MANUAL_SINCE`; set
   `OUTREACH_DAILY_LIMIT=200` (max imports per day) and the conservative sending limits (defaults 10/member/day, 25/day, 3/run); create
   the cron-job.org job (every 5-10 minutes, Bearer secret). Watch `SendsNeedingReview`, `FailedSends` and bounces daily; raise limits
   gradually. To stop immediately: unset `OUTREACH_ENABLED` (or set `OUTREACH_SEND_PER_RUN=0`).

## 11. Operational risks
- Two members could still send their own (non-owner) drafts by hand for the same contact; automation cannot edit or remove their drafts.
- Sheets is not transactional: the claim protocol is safe against concurrent crons but a person editing ledger rows by hand can defeat it.
- Without the metadata permission an uncertain send cannot be proven either way and always needs a person.
- Many addresses come from old lists: bounces damage sender reputation. Start slowly; remove bounced addresses via `Outreach Exclusions`.
- A deleted Connection stops further processing of that contact; an already-sent message cannot be recalled.
- Dependency advisories apply to the installed Next.js (16.4.0): see the security note delivered with this change; upgrade to 16.4.5 before any production activation.
