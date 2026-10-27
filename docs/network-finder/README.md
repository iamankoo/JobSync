# Network Finder (Phase 2) — the FREE pipeline

Server-side discovery of companies, decision-makers and openings, saved into the EXISTING Connections and
Jobs through their own services, with a personalised Gmail **draft** for each day's selected contact in each
member's own mailbox. Nothing ever sends an email. Apollo is optional. Everything is OFF unless
`NETWORK_FINDER_ENABLED=true`.

## Sources (all permitted, public, no logins, robots.txt respected)

| Step | Source | Notes |
|---|---|---|
| Companies | HN "Ask HN: Who is hiring?" via the public HN Search API (hn.algolia.com) | name, website, location, remote, careers link; size only when the post states it |
| Companies | remoteintech.company directory (open source, ISC) via its public GitHub repo | website, careers page, stated size band; **no country** |
| Companies (manual) | YC, Wellfound, LinkedIn | reference only — never scraped |
| Size / country (optional) | Apollo organization enrich (works on the Free plan; account 1 only unless `APOLLO_ENABLED_ACCOUNTS`) | fills only what the source did not state |
| Size / country (free) | the company's own homepage + about page | an explicit sentence ("a team of 12", "based in London"), found by rules or Nemotron and re-checked against the page |
| Contacts | the company's own public pages (home → team / about / leadership / contact / careers; `/team` and `/about` tried if not linked) + the company's public hiring post | Nemotron reads names + titles; every field is re-checked against the page |
| Contacts (optional) | Apollo people search / enrichment | Free plan refuses (403) → warning, free pipeline continues |
| Jobs | the company's Greenhouse / Lever board **linked from its own site** (never guessed from the name) | public board APIs |
| Jobs (daily 5 + 5) | Remote OK API (credited as the source), Arbeitnow API | Remotive excluded: its robots.txt disallows the API |

## Per company

1. People from the free finders (+ Apollo if it works) → only useful personas (recruiter → hiring manager →
   founder/CEO/CTO → referrer) → Nemotron chooses; the priority order stays a hard rule.
2. De-duplicate against Connections (email → LinkedIn URL → name + company). People already there count toward
   the 3, so retries top up instead of adding a new set.
3. Email: a **public** address published for that person is saved as such (with the page). Otherwise a
   **Predicted / Unverified** address only if the company's own pages publish named examples that all follow one
   pattern (e.g. `first.last@`). Generic inboxes are never evidence. Predicted addresses are labelled
   "VERIFY BEFORE SENDING" in Notes.
4. Save via `createConnection` as Anni: status Not Connected, Message empty; source page, email status/source,
   phone (only if published), discovery date, persona and assignee go in Notes (no new contact store).
5. **Selection**: one contact per company (best persona, preferring one with an email) → assigned in turn
   Anni / Lukky / Rishii up to **17 / 17 / 16 = 50 a day** ("Assigned to" in Notes; the record stays Anni's).
6. **Drafts — for EVERY saved contact, in all three mailboxes** (independent of owner / assignee): Nemotron writes
   one draft per member (their own name and `NETWORK_FINDER_PROFILE_<MEMBER>` only; `NETWORK_FINDER_SIGNATURE_<MEMBER>`
   appended unchanged) → `users.drafts.create` in that member's own Gmail (scope `gmail.compose`). The selected
   contact is drafted first. Ledger NF_Drafts prevents duplicates. Drafts that do not fit in a run, failures, and
   members who connect Gmail later are caught up by later runs (contacts of the last 3 days still Not Connected).
7. Jobs from the company's board → rules first, Nemotron only for unclear titles (≤10 checks a run) → `createJob`
   as Anni, quietly (no per-job push).

## Schedule, limits, notifications

- cron-job.org calls `GET /api/cron/network-finder` with `Authorization: Bearer $NETWORK_FINDER_CRON_SECRET`
  every ~5 minutes. Each call: sent-draft check → (inside a window) one company → pending drafts → daily job
  search → job re-checks, within a 50 s budget (anything unfinished resumes next call). A run lock prevents
  overlaps. The response contains counts only (no names or emails).
- Sent tracking needs `GMAIL_TRACK_SENT=true` BEFORE members connect Gmail (it adds the read-only `gmail.metadata`
  permission). Without it a sent draft cannot be told from a deleted one, and statuses are never changed.
- Windows (APP_TIMEZONE): 02–04, 06–08, 10–12, 14–16, 18–20, ten companies each. Day plan: companies 1–30 have
  1–25 employees, 31–40 ≤100, 41–50 ≤250; ~70% US / 30% SG, GB, CA, DE, AE, AU, FR, IT, PL.
- One push summary per batch of 10 (or when a window runs dry) to all three members — none per contact.
- When Connections reaches `NETWORK_FINDER_CONTACT_LIMIT` (1000): no new contacts, all three told once a day,
  nothing exported or deleted, everything else keeps working.
- Rate limits: a site's 429 / Retry-After is obeyed (company retried later, no attempt used); Nemotron is paced
  (`NEMOTRON_MAX_RPM`, default 30) and decisions fall back to rules; drafts are never faked.

## Storage (existing spreadsheet, optional tabs)

NF_Companies (registry), NF_Queue (durable queue with leases), NF_State (counters, cursors, pause, Apollo usage,
run lock), NF_Selections (daily selection + assignee + mailboxes drafted), NF_Drafts, NF_GmailAccounts.

## Tests

- `npm test` — mocks only (fake web, fake mailboxes, in-memory sheet).
- Live, opt-in, small (≤3 companies, in-memory sheet, no Gmail):
  `npx vitest run --config vitest.network-finder-live.config.mts tests/live/network-finder-free.nf-live.test.ts`
