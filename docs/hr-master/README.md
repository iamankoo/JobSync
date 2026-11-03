# HR Master Contact Database (Part 1)

> The generated files described below (`data/hr-master/*`, `Mail-Data/*`) contain third-party e-mail addresses and are **deliberately not committed** (this repository is public). They stay on the machine that built them; the Outreach Database Google Sheet is the working store. Rebuild with the commands at the end of this file.

A cleaned, deduplicated, evidence-annotated list of HR / recruitment / outreach contacts built from the five files in
`Mail-Data/`. **It is a local research and import source only.** Google Sheets remains JobSync's only application database;
nothing here has been imported into Connections, and no production Sheets, Gmail or Network Finder data was touched.

Counts and coverage live in [`research-summary.md`](research-summary.md) (regenerated on every build).

## Files

| File | What it is |
|---|---|
| `master-contacts.json` | The master database. One object per unique contact (compact JSON array). |
| `master-contacts.csv` | The same rows as CSV (arrays joined with ` \| `, `Conflicts` as JSON). |
| `unresolved-contacts.csv` | Contacts whose company is unresolved or whose domain is not yet researched. |
| `companies.json` | One record per company-owned e-mail domain: company + role assessment, reused by every contact there. |
| `research-summary.md` | Generated counts: extraction, dedupe, verification states, role categories. |
| `review-duplicate-groups.json` | Look-alike contacts that were deliberately **not** merged (same name + organisation, different address). |
| `conflicts.json` | Every field where two sources disagreed, with all values and their source locations. |
| `invalid-records.json` | Raw records without a usable e-mail address (kept, with the reason). |
| `work/` | Intermediates and the resumable log: `raw-records.json`, `deduped.json`, `domain-research.jsonl`, `research-progress.json`, `xlsx-rows.json`, `pdf-pages.json`. Safe to delete and regenerate. |

## Master schema (`SchemaVersion` 2)

Required fields first, exactly as specified in the brief; the additional fields follow.

| Field | Type | Meaning |
|---|---|---|
| `ContactID` | string `HRC-XXXXXXXXXXXX` | Stable id, see below. |
| `PersonName` | string | Name from the highest-priority source that gave a real person name; `""` for role mailboxes / placeholders such as "HR". |
| `PersonDesignation` | string | Designation as listed; `""` if no source gave one. |
| `PersonEmail` | string | Normalised (lower-case) primary address. Unique across the file. |
| `EmailDomain` | string | Domain of `PersonEmail`. |
| `CompanyName` | string | Name taken from the company's own website when it relates to the stated/known name; otherwise the name the source files state. |
| `CompanyURL` | string | Final URL of the company website that was actually fetched; `""` if none. |
| `CompanyDomain` | string | Verified company domain; `""` unless the site was read (public e-mail providers are never used). |
| `PrimaryRoleCategory` | one of the 13 approved categories, or `Unverified` | Best-supported category. |
| `AdditionalRoleCategories` | array of approved categories | Other categories with their own evidence. |
| `CompanyDescription` | string | The company's own meta description (not rewritten). |
| `HiringEvidence` | string | What the careers page / homepage showed, and whether it is a listing or only a general indication. |
| `PersonVerificationStatus` | `Verified` / `Partially Verified` / `Unverified` | See definitions. |
| `CompanyVerificationStatus` | same | See definitions. |
| `RoleVerificationStatus` | same | See definitions. |
| `ResearchSources` | array of URLs | Only pages that were actually fetched. |
| `SourceFiles` | array | Every source file the contact appeared in. |
| `SourceLocations` | array | `file: row/line/page/record` for every occurrence. |
| `DuplicateGroup` | string | `DG-...` id when the contact is in a review group; `""` otherwise. |
| `ResearchNotes` | string | Uncertainties, conflicts, mismatches, caveats (` \| `-separated). |
| `LastResearchedAt` | ISO-8601 or `""` | When the company site was read; `""` = not researched. |
| `ContactKind` | `person` / `role-mailbox` / `unknown` | Whether a real individual is named. |
| `EmailKind` | `company` / `public-provider` / `legacy-isp` | What kind of address. |
| `AlternateEmails` | array | Addresses a source explicitly marked as alternates for the same person. |
| `CareersURL` | string | Careers page found on the company's site/ATS, `""` if none. |
| `PersonEvidence` | string | Which source lists the person's name/designation (and that no public confirmation was gathered). |
| `Conflicts` | array | Structured conflicts (see `conflicts.json`). |
| `ResolutionStatus` | `resolved` / `unresolved` / `pending-research` | `resolved`: company-owned domain whose site was read and is at least Partially Verified. |
| `RoleBasis` | `careers-listing` / `company-description` / `company-inferred` / `default-fallback` / `""` | How `PrimaryRoleCategory` was reached. `company-inferred` = classified only from what the company mainly does (software or AI) on its own homepage/About page; it is **not** an individual designation and confirms no opening. `default-fallback` = the company is not clearly AI- or software-focused (other industry, or insufficient information, or no company at all), so `Software Engineer` was applied as the agreed default for software-engineering outreach (status stays `Unverified`; evidence starts `DEFAULT FALLBACK` and says which case). Every contact therefore has a role category; `PrimaryRoleCategory = Unverified` no longer occurs. |
| `SalutationName` | string | Person's name, or **Hiring Team** when `PersonName` is empty (never an invented name). |
| `CompanyReference` | string | Company name for message text, or **your company** when `CompanyName` is empty. `CompanyName` itself stays empty then. |
| `SchemaVersion` | number | Currently `2` (v2 added `RoleBasis`). |

The schema is enforced at build time by `src/lib/hr-master/schema.ts` (strict zod object + cross-row invariants: unique
ContactID/e-mail, ContactID matches e-mail, status/evidence consistency). The build aborts if any row fails.

### Verification definitions

- **Company: Verified** - the company-owned e-mail domain serves a real website, with no redirect to another registrable domain,
  and that site names the company the source files state for the contact. **Partially Verified** - the site is live but does
  not name the stated company, redirects elsewhere, or no company name was supplied to compare. **Unverified** - public
  e-mail provider, legacy ISP address, unreachable / parked / robots-blocked site, or not researched.
- **Role: Verified** - a job title that maps to an approved category appears on the company's fetched careers page (a listing,
  seen at fetch time; confirm it is still open before applying). **Partially Verified** - the company's own pages describe
  work in that category, a *general* indication only; no current opening is claimed. **Unverified** - nothing justifies an
  approved category (`PrimaryRoleCategory = Unverified`). Being "a tech company" alone earns nothing.
  A last-resort **company-focus pass** (`company-focus.ts`, About pages via `research-about.mts`) can set `Software Engineer` or
  `AI Engineer` for otherwise-Unverified roles when the company's own homepage headline or About-page opening clearly says it is
  primarily a software or AI business; these are `Partially Verified` with `RoleBasis = company-inferred` and an evidence string
  starting `COMPANY-BASED INFERENCE`. Vague wording ("technology company"), non-software sectors and unreadable sites stay Unverified. Later stages, in order of
  evidence and only for roles still Unverified: a strict whole-homepage read (3 distinct signals), then explicit field words in the
  company's own name ("... Software Services", "... AI"; a `.ai` web suffix does not count), then the universal `default-fallback` to Software Engineer.
  Roles backed by a careers listing or business description are never changed by these stages.
- **Person: Partially Verified** - named person with a designation at a company-owned domain whose site was read, corroborated
  by the e-mail local part matching the name or by appearing in two independent files. **Verified is intentionally not
  assigned**: that would need an independent public source for each individual (company team page, official profile), which
  was not gathered; an e-mail address in a list never counts. **Unverified** - everything else (role mailboxes, no name, no
  designation, public/legacy addresses, uncorroborated single listings).

## ContactID strategy

`HRC-` + first 12 hex characters (upper-case) of SHA-256 of the **normalised primary e-mail address**.

- Same e-mail => same ID, regardless of file order, row number, source, or research results.
- A future importer can re-derive it from the e-mail alone, so it doubles as the duplicate-prevention key.
- 48 bits; the builder throws on any collision (none among the current contacts).

## Deduplication rules

1. Records are merged **only** when their normalised e-mail addresses are identical (lower-case; `mailto:`/wrapping punctuation
   stripped; stray whitespace around `.`/`@` repaired and noted). This is the "same name AND same contact" rule: a shared name or
   shared company domain never merges two people.
2. Every source reference and the original (verbatim) values of every merged record are kept (`SourceFiles`, `SourceLocations`).
3. Disagreements (name, designation, company) are never dropped silently: the value from the higher-priority source is shown
   (`data.json` > `HR_List_2026.xlsx` > `companies.md` > `unified_emails.csv` > the PDF), all values are in `Conflicts` and in
   `ResearchNotes`. Wording variants of the same value ("Acme" vs "Acme Pvt Ltd") are not conflicts.
4. Same name at the same organisation but different addresses are kept separate and listed in `review-duplicate-groups.json`.
   Addresses a source labels `alt:` are stored in `AlternateEmails` on that contact.
5. Garbage fields are not promoted: spreadsheet-formula residue (`=A2318`), names equal to the domain, and placeholders
   ("HR", "Hiring Team") are not used as names or companies.

## Research methodology

1. **Extract** all five files completely (`src/lib/hr-master/extract.ts`): CSV, JSON, the XLSX sheet (converted to rows by
   `scripts/hr-master/binary-to-json.py`), the markdown table, and the PDF text layer (company inferred from the preceding
   heading line, flagged as uncertain on every such record).
2. **Normalise and deduplicate before any web research.**
3. **Group by company-owned e-mail domain** and research each domain **once** (`scripts/hr-master/research-domains.mts`): read the
   public homepage (title, meta description, site name, visible text), honour `robots.txt`, find the careers link on the site
   or a well-known ATS host, read that page and extract job titles. No login, CAPTCHA or paywall is bypassed; no LinkedIn or other
   restricted source is scraped.
4. **Assess** deterministically from the fetched evidence (`src/lib/hr-master/research.ts`): company ownership, role category,
   person status. Public providers (Gmail, Yahoo, Outlook, ...) and legacy ISP addresses are never used to infer an employer.
5. **Build** the master rows and validate them (`scripts/hr-master/build-master.mts`).

Source types used: the company's own homepage and careers page, and company-listed ATS pages. The source files themselves are
the only evidence for a person's name and designation.

### Resume / restart

`work/domain-research.jsonl` is append-only, one line per researched domain. Re-running `research-domains.mts` skips everything
already in it (an interrupted last line is ignored and redone). `--retry-errors` redoes unreachable/error results; `--limit N` bounds
a run. `build-master.mts` can be run at any time: unresearched domains appear as `pending-research`, never as guesses.

## Rebuild

```
python -I scripts/hr-master/binary-to-json.py            # needs: pip install openpyxl pypdf (not project dependencies)
node --experimental-strip-types --no-warnings scripts/hr-master/extract-all.mts
node --experimental-strip-types --no-warnings scripts/hr-master/research-domains.mts [--concurrency 60] [--retry-errors] [--limit N]
node --experimental-strip-types --no-warnings scripts/hr-master/build-master.mts
```

Keep concurrency moderate (about 60); at 160 a home connection produced false "unreachable" results.

## Part 2 integration contract

Implemented as tested, unused code in `src/lib/hr-master/connections-mapping.ts`.

**Reading the data.** An importer reads `master-contacts.json`, validates it with `validateMaster` (same module as the build), and
processes rows in `ContactID` order. Only rows passing `importReadiness` (company-owned address, company at least Partially
Verified, a justified role category, research finished) are suggested for import; the policy is a proposal and easy to tighten.

**Field mapping to the existing Connections columns**

| Master field | Connections column |
|---|---|
| `PersonName` (role mailbox: "Hiring team") | `Name` |
| `CompanyName` | `Company` |
| `PersonDesignation` | `Role` (the person's title, not the role to apply for) |
| `PersonEmail` | `Email` |
| `CompanyURL` | `CompanyUrl` |
| `PrimaryRoleCategory` | `RoleCategory` + `ApplyRole` via `APPROVED_TO_APPLY_ROLE` (every pair satisfies `applyRoleProblem`; `MERN Stack Engineer` goes in as a custom "Other" role; `Unverified` leaves both empty) |
| `ContactID` | `Notes` ("HR master HRC-...") until a dedicated column exists |

**Duplicate prevention.** Key = normalised e-mail (`duplicateKey`). Before inserting, the importer must check the key against
existing Connections (all members, since the same HR person should not be contacted by several members unintentionally) and
against already-imported `ContactID`s; skip, never overwrite, an existing row. Review-group members should be imported
one-per-group or held back for a human.

**Fields the Connections model may need (not added in Part 1).** Optional trailing columns such as `ContactID` (hard
duplicate key and traceability), `Origin` (`hr-master`), `CompanyVerification`/`RoleVerification` (so the UI can show
confidence), and `LastResearchedAt`. The sheet layer already tolerates optional trailing columns.

## Limitations

- Per-person verification: no independent public confirmation per individual was gathered, so no person is `Verified`.
- Company research covers only company-owned e-mail domains. Contacts on Gmail/Yahoo/etc. and legacy-ISP addresses have no
  verifiable employer and stay `unresolved` with the source-stated company name only.
- JavaScript-rendered careers pages show no static job titles, so a company may be `Partially Verified` (or `Unverified`) for role
  even though it is hiring. Absence of evidence is recorded as such, not as "not hiring".
- Many addresses come from old lists (2000s-era PDF, scraped CSVs) and may be stale; an address's existence or deliverability was
  not tested (no mail was sent, no SMTP probing).
- Domains that were unreachable at research time may be only temporarily down; rerun with `--retry-errors`.
- The CSV contains U+FFFD replacement characters in some titles where the original encoding was already lost; the original text
  cannot be recovered and is flagged in the uncertainties.
