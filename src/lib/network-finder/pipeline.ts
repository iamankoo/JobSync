import { getMember, MEMBER_IDS, type MemberId } from "@/config/members";
import type { Connection } from "@/types/domain";
import { dateInTimezone } from "@/lib/utils/time";
import type { ApolloPool } from "./apollo-pool";
import type { NetworkFinderConfig } from "./config";
import { classifyPersona, rankPeople } from "./contacts";
import { ConnectionIndex, JobIndex, normalizePersonName } from "./dedupe";
import { countsByMember, nextAssignee, type Selection, type SelectionStore } from "./distribution";
import { distributeDrafts, draftKey, type FanoutDeps, type MemberDraftOutcome } from "./draft-fanout";
import { inferPattern, predictEmail, type PatternEvidence } from "./email-pattern";
import { ApolloPoolExhausted, ProviderError } from "./errors";
import type { ConnectionsGateway, JobsGateway } from "./gateways";
import { toConnectionInput, toJobInput } from "./mapping";
import { ruleBrain, type Brain } from "./providers/brain";
import type { CompanySource, ContactFinder, ContactProvider, JobSource } from "./providers/types";
import { planBatch, qualifyCompany } from "./qualify";
import { backoffDelay, type WorkQueue } from "./queue";
import { recordFor, dueForJobRecheck, type CompanyRegistry } from "./registry";
import { classifyEmployment, matchRole, ruleVerdict, TARGET_ROLES } from "./roles";
import { activeWindow, BATCH_WINDOWS, type ActiveWindow, type BatchLedger } from "./scheduler";
import { INTERNATIONAL_COUNTRIES, type CompanyCandidate, type EnrichedPerson, type JobCandidate, type QualifiedCompany, type RankedPerson } from "./types";

/**
 * Network Finder orchestration (FREE pipeline; Apollo optional):
 *
 *   discover (public sources) → qualify → [optional enrichment of missing size/country] → plan the day
 *   (30 × 1–25, 10 × ≤100, 10 × ≤250; ~70% US) → queue
 *   → per company: people from the company's public pages / public post (+ Apollo if it works) → brain picks
 *     the useful ones (recruiter → hiring manager → founder → referrer) → de-duplicate → public / predicted email
 *     → save through the Connections service (owner Anni, Not Connected, no message)
 *     → ONE selected contact per company, assigned Anni/Lukky/Rishii (17/17/16 a day)
 *     → for EVERY saved contact, a personalised Gmail DRAFT in each member's own mailbox (never sent)
 *     → openings from public job boards → save through the Jobs service (as Anni)
 *
 * Everything external is injected, so the same code runs against mocks (tests) and the real adapters.
 */
export interface DraftStepDeps {
  members?: FanoutDeps["members"];
  createDraft: FanoutDeps["createDraft"];
  isConnected: FanoutDeps["isConnected"];
  ledger: FanoutDeps["ledger"];
  /** Optional: the whole draft ledger in one read (lets the pending-draft scan avoid one read per key). */
  snapshot?: () => Promise<ReadonlyMap<string, { status: string }>>;
}

/** One summary push to the team (each member's devices). Never throws. */
export interface BatchNotifier {
  notifyTeam(message: { title: string; body: string; tag: string }): Promise<void>;
}

export interface PipelineDeps {
  config: NetworkFinderConfig;
  sources: readonly CompanySource[];
  /** Free contact sources (company websites, the company's public post). */
  contactFinders?: readonly ContactFinder[];
  /** OPTIONAL Apollo people search/enrichment. A plan restriction or exhausted quota never fails a company. */
  contacts?: ContactProvider;
  pool?: ApolloPool;
  /** OPTIONAL: fills in a candidate's missing size / country from a real source (e.g. Apollo organization enrich). */
  enrichCompany?: (c: CompanyCandidate) => Promise<CompanyCandidate | null>;
  brain?: Brain;
  jobSources: readonly JobSource[];
  queue: WorkQueue<CompanyTask>;
  registry: CompanyRegistry;
  ledger: BatchLedger;
  selections?: SelectionStore;
  drafts?: DraftStepDeps;
  notifier?: BatchNotifier;
  connections: ConnectionsGateway;
  jobs: JobsGateway;
  now?: () => Date;
  /** Per-run state (e.g. Apollo switched off after a plan restriction, so it is not asked again this run). */
  runState?: {
    apolloOff?: string;
    enrichOff?: string;
    relevanceChecksLeft?: number;
    /** Epoch ms by which this run must wrap up (the function time limit); slow steps stop early and resume next run. */
    deadline?: number;
  };
}

/** Milliseconds left in this run (Infinity when the run has no deadline, e.g. tests and local scripts). */
export const timeLeft = (d: PipelineDeps) => (d.runState?.deadline ? d.runState.deadline - Date.now() : Number.POSITIVE_INFINITY);
/** Time a company needs (pages at 1 request/second, Nemotron, Sheets): it is not started with less left. */
const COMPANY_TIME_MS = 30_000;
/** Time one draft round (3 mailboxes) needs. */
const DRAFT_TIME_MS = 12_000;
/** Time one enrichment needs (pages + Nemotron). */
const ENRICH_TIME_MS = 8_000;

export interface CompanyTask {
  company: QualifiedCompany;
}

export type Skip = { name: string; reason: string };

export interface CompanyOutcome {
  companyKey: string;
  peopleFound: number;
  contactsSaved: string[];
  contactsSkipped: Skip[];
  jobsSaved: string[];
  jobsSkipped: Skip[];
  /** Provider problems that did not stop the company (e.g. a job source was down, Apollo not in plan). */
  warnings: string[];
  /** Today's selected contact for this company (drafts go to all three members). */
  selected?: { connectionId: string; name: string; assignedTo: MemberId; email?: string; emailStatus: string };
  drafts?: MemberDraftOutcome[];
  /** Contacts whose drafts did not fit in this run (finished by a later run's runPendingDrafts). */
  draftsDeferred?: number;
  /** Connections reached the contact limit: no contacts were added. */
  limitReached?: boolean;
}

const now = (d: PipelineDeps) => (d.now ? d.now() : new Date());
const brainOf = (d: PipelineDeps) => d.brain ?? ruleBrain;
const taskId = (key: string) => `company:${key}`;
/** How many people to look at per company before enriching (enrichment costs credits; search is broader). */
const SEARCH_LIMIT = 10;
/** Optional enrichment calls per discovery run (each is one Apollo credit). */
const ENRICH_PER_RUN = 15;
const describe = (err: unknown, fallback: string) => (err instanceof ProviderError ? `${err.provider}: ${err.kind}` : err instanceof ApolloPoolExhausted ? "apollo: all accounts exhausted" : fallback);

// ---- discovery ------------------------------------------------------------------------------------------

export interface DiscoveryResult {
  enqueued: QualifiedCompany[];
  rejected: number;
  alreadyKnown: number;
  errors: string[];
  /** Why candidates were rejected, counted (e.g. "employee count unknown": 12). */
  rejections?: Record<string, number>;
}

/** Finds up to `wanted` new, qualified companies for the next slots of the day and queues them. Known companies are never re-queued. */
export async function discoverCompanies(deps: PipelineDeps, wanted: number): Promise<DiscoveryResult> {
  const at = now(deps);
  const day = dateInTimezone(at, deps.config.timeZone);
  const result: DiscoveryResult = { enqueued: [], rejected: 0, alreadyKnown: 0, errors: [], rejections: {} };
  const qualified: QualifiedCompany[] = [];
  let enrichBudget = ENRICH_PER_RUN;
  deps.runState ??= {};
  for (const source of deps.sources) {
    try {
      const page = await source.discover({ maxEmployees: 250, countries: ["US", ...INTERNATIONAL_COUNTRIES], limit: Math.max(wanted * 3, 10), cursor: await deps.registry.getCursor(source.id) });
      await deps.registry.setCursor(source.id, page.nextCursor);
      for (const raw of page.companies) {
        let c = raw;
        let q = qualifyCompany(c);
        // Size or country not stated: ask the optional enrichment (a real source), never guess.
        if (!q.qualified && /unknown/.test(q.reason) && c.website && deps.enrichCompany && !deps.runState.enrichOff && enrichBudget > 0 && timeLeft(deps) > COMPANY_TIME_MS + ENRICH_TIME_MS) {
          enrichBudget -= 1;
          try {
            const e = await deps.enrichCompany(c);
            if (e) {
              c = { ...c, ...(c.employeeCount === undefined && e.employeeCount !== undefined ? { employeeCount: e.employeeCount } : {}), ...(!c.countryCode && e.countryCode ? { countryCode: e.countryCode } : {}), ...(e.apolloOrgId ? { apolloOrgId: e.apolloOrgId } : {}), ...(!c.description && e.description ? { description: e.description } : {}), ...(e.factsSource ? { factsSource: e.factsSource } : {}) };
              q = qualifyCompany(c);
            }
          } catch (err) {
            deps.runState.enrichOff = describe(err, "enrichment failed");
            result.errors.push(`enrichment off for this run (${deps.runState.enrichOff})`);
          }
        }
        if (!q.qualified) {
          result.rejected += 1;
          const reason = q.reason.replace(/\(\d+ employees\)/, "").replace(/country \w+ is/, "country is").trim();
          result.rejections![reason] = (result.rejections![reason] ?? 0) + 1;
          continue;
        }
        if (await deps.registry.get(q.company.key)) {
          result.alreadyKnown += 1;
          continue;
        }
        qualified.push(q.company);
      }
    } catch (err) {
      // A source being down or not connected is reported, never papered over with made-up companies.
      result.errors.push(err instanceof ProviderError ? `${err.provider}: ${err.kind}` : `${source.id}: unexpected error`);
    }
  }
  if (qualified.length === 0) return result;
  // The brain scores (only the given companies); the hard rules (tier plan, 70/30) then fill the day's slots.
  const scored = await brainOf(deps).prioritizeCompanies(qualified, qualified.length);
  const startIndex = await deps.ledger.get(`${day}#enqueued`);
  for (const company of planBatch(scored, startIndex, wanted)) {
    if (await deps.queue.enqueue(taskId(company.key), { company }, at.getTime())) {
      await deps.registry.put(recordFor(company, at.toISOString()));
      await deps.ledger.add(`${day}#enqueued`, 1);
      result.enqueued.push(company);
    }
  }
  return result;
}

// ---- one company ----------------------------------------------------------------------------------------

type Candidate = EnrichedPerson & { needsEnrich?: boolean };

/** People from the free finders, plus Apollo if it is available. Returns the pattern evidence too. */
async function gatherPeople(deps: PipelineDeps, company: QualifiedCompany, out: CompanyOutcome): Promise<{ people: Candidate[]; pattern: PatternEvidence | null }> {
  const people: Candidate[] = [];
  const named: { name: string; email: string }[] = [];
  const hosts = new Set<string>(company.domain ? [company.domain] : []);
  for (const finder of deps.contactFinders ?? []) {
    try {
      const found = await finder.findPeople(company);
      for (const h of found.hosts ?? []) hosts.add(h);
      for (const p of found.people) {
        people.push(p);
        if (p.email && p.emailStatus === "public") named.push({ name: p.name, email: p.email });
      }
    } catch (err) {
      // A site asking us to slow down: the company is retried later (nothing is forced).
      if (err instanceof ProviderError && err.kind === "rate_limited") throw err;
      out.warnings.push(describe(err, `${finder.id}: unexpected error`));
    }
  }
  if (deps.contacts && deps.pool && !deps.runState?.apolloOff) {
    try {
      const found = await deps.pool.call(1, (ctx) => deps.contacts!.searchPeople(company, { limit: SEARCH_LIMIT }, ctx));
      for (const p of found) people.push({ ...p, emailStatus: p.email ? "unverified" : "unavailable", needsEnrich: true });
    } catch (err) {
      apolloOff(deps, err, out);
    }
  }
  // The pattern of whichever of the company's own domains has published, named examples.
  let pattern: PatternEvidence | null = null;
  for (const h of hosts) pattern ??= inferPattern(named, h);
  return { people, pattern };
}

/** Apollo is optional: a plan restriction / exhausted quota switches it off for this run and the free pipeline continues. */
function apolloOff(deps: PipelineDeps, err: unknown, out: CompanyOutcome): void {
  if (err instanceof ApolloPoolExhausted || (err instanceof ProviderError && err.provider === "apollo")) {
    deps.runState ??= {};
    deps.runState.apolloOff = describe(err, "apollo");
    out.warnings.push(`${deps.runState.apolloOff} — continuing with free sources`);
    return;
  }
  throw err;
}

const isNetworkFinderEntry = (c: Connection | undefined) => Boolean(c && (c.notes ?? "").startsWith("Source: Network Finder"));

/**
 * Saves up to `peoplePerCompany` new people and any new relevant openings for one company, selects the day's
 * contact for it and creates the drafts. Safe to run again for the same company (e.g. after a crash): people,
 * jobs, the selection and every draft are de-duplicated.
 */
export async function processCompany(deps: PipelineDeps, company: QualifiedCompany): Promise<CompanyOutcome> {
  const at = now(deps);
  const day = dateInTimezone(at, deps.config.timeZone);
  const out: CompanyOutcome = { companyKey: company.key, peopleFound: 0, contactsSaved: [], contactsSkipped: [], jobsSaved: [], jobsSkipped: [], warnings: [] };

  const existing = await deps.connections.list();
  const byId = new Map(existing.map((c) => [c.connectionId, c]));
  if (existing.length >= deps.config.contactLimit) {
    out.limitReached = true;
  } else {
    await saveCompanyContacts(deps, company, out, existing, byId, day, at);
  }

  await saveCompanyJobs(deps, company, out, day);

  const rec = (await deps.registry.get(company.key)) ?? recordFor(company, at.toISOString());
  await deps.registry.put({
    ...rec,
    status: rec.contactsSaved + out.contactsSaved.length > 0 || out.selected ? "processed" : "no_contacts",
    lastProcessedAt: at.toISOString(),
    lastJobCheckAt: at.toISOString(),
    contactsSaved: rec.contactsSaved + out.contactsSaved.length,
    jobsSaved: rec.jobsSaved + out.jobsSaved.length,
  });
  return out;
}

async function saveCompanyContacts(deps: PipelineDeps, company: QualifiedCompany, out: CompanyOutcome, existing: Connection[], byId: Map<string, Connection>, day: string, at: Date) {
  const index = ConnectionIndex.from(existing);
  const { people, pattern } = await gatherPeople(deps, company, out);
  out.peopleFound = people.length;

  // One entry per person across sources (a website person and the same Apollo person merge; details kept).
  const merged: Candidate[] = [];
  for (const p of people) {
    const twin = merged.find((m) => normalizePersonName(m.name) === normalizePersonName(p.name));
    if (twin) Object.assign(twin, { ...p, ...twin, email: twin.email ?? p.email, linkedinUrl: twin.linkedinUrl ?? p.linkedinUrl, providerId: twin.providerId ?? p.providerId, needsEnrich: Boolean(twin.needsEnrich && p.needsEnrich) });
    else merged.push({ ...p });
  }
  for (const p of merged) if (!classifyPersona(p.title)) out.contactsSkipped.push({ name: p.name, reason: "role not relevant" });
  const relevant = merged.filter((p) => classifyPersona(p.title));
  // The brain decides who is worth contacting; the priority ORDER stays a hard rule inside every brain.
  const chosen = (await brainOf(deps).choosePeople(company, relevant, relevant.length)) as Candidate[];

  // People already in Connections count toward the target, so a retry tops up instead of adding a fresh set.
  let have = 0;
  const eligibleForSelection: { connectionId: string; person: RankedPerson }[] = [];
  const toSave: RankedPerson[] = [];
  for (const person of chosen) {
    if (have + toSave.length >= deps.config.peoplePerCompany) break;
    const knownId = index.idOf(person);
    if (index.duplicateOf(person)) {
      have += 1;
      out.contactsSkipped.push({ name: person.name, reason: `already in Connections (${index.duplicateOf(person)})` });
      const c = knownId ? byId.get(knownId) : undefined;
      // A contact this pipeline saved earlier (interrupted run) can still be today's selection.
      if (c && isNetworkFinderEntry(c) && c.status === "Not Connected") eligibleForSelection.push({ connectionId: c.connectionId, person: { ...person, email: c.email ?? person.email, persona: classifyPersona(person.title)! } });
      continue;
    }
    let p: EnrichedPerson = person;
    if (person.needsEnrich && !person.email && deps.contacts && deps.pool && !deps.runState?.apolloOff) {
      try {
        p = await deps.pool.call(1, (ctx, accountId) => deps.contacts!.enrichPerson(person, ctx).then((e) => ({ ...e, enrichedBy: accountId })));
      } catch (err) {
        apolloOff(deps, err, out);
      }
    }
    if (!p.email && pattern) {
      const guess = predictEmail(p.name, pattern);
      if (guess) p = { ...p, email: guess, emailStatus: "predicted", emailSource: `company pattern "${pattern.pattern}@${pattern.domain}" from published ${pattern.examples.join(", ")}` };
    }
    const [ranked] = rankPeople([p], 1);
    if (!ranked) {
      out.contactsSkipped.push({ name: person.name, reason: "no way to reach them (no email or profile)" });
      continue;
    }
    if (index.duplicateOf(ranked)) {
      have += 1;
      out.contactsSkipped.push({ name: person.name, reason: `already in Connections (${index.duplicateOf(ranked)})` });
      continue;
    }
    toSave.push(ranked);
    index.add(ranked);
  }

  // Today's selection for this company: the best contact (priority order), preferring one with an email.
  const alreadySelected = deps.selections ? await deps.selections.get(company.key) : undefined;
  let assignee: MemberId | null = null;
  let selectIdx = -1;
  if (deps.selections && !alreadySelected) {
    assignee = nextAssignee(countsByMember(await deps.selections.forDay(day)));
    const pool = [...eligibleForSelection.map((e) => e.person), ...toSave];
    const best = pool.findIndex((p) => p.email) >= 0 ? pool.findIndex((p) => p.email) : pool.length ? 0 : -1;
    selectIdx = best - eligibleForSelection.length; // ≥ 0 → one of the new people
    if (best >= 0 && best < eligibleForSelection.length && assignee) {
      await recordSelection(deps, company, out, eligibleForSelection[best].connectionId, eligibleForSelection[best].person, assignee, day, at);
    }
  }

  const saved: DraftTarget[] = [];
  for (let i = 0; i < toSave.length; i++) {
    const ranked = toSave[i];
    const isSelected = i === selectIdx && assignee !== null;
    try {
      const created = await deps.connections.create(deps.config.contactOwner, toConnectionInput(ranked, company, day, isSelected ? { assignedTo: getMember(assignee!)?.name ?? assignee! } : {}));
      out.contactsSaved.push(ranked.name);
      if (isSelected) await recordSelection(deps, company, out, created.connectionId, ranked, assignee!, day, at);
      else saved.push({ connectionId: created.connectionId, name: ranked.name, title: ranked.title, ...(ranked.email ? { email: ranked.email } : {}), company });
    } catch (err) {
      out.contactsSkipped.push({ name: ranked.name, reason: `could not be saved (${err instanceof Error ? err.name : "error"})` });
      if (!(err instanceof Error && err.name === "ZodError")) throw err; // data-layer problems stop the company (retried later)
    }
  }

  // Drafts in all three mailboxes for EVERY contact saved: today's selection first (also completing drafts an
  // interrupted run did not finish), then the others. What does not fit in this run is finished by runPendingDrafts.
  if (!deps.drafts) return;
  out.drafts = [];
  out.draftsDeferred = 0;
  const selection = deps.selections ? await deps.selections.get(company.key) : undefined;
  if (selection) {
    if (timeLeft(deps) > DRAFT_TIME_MS) out.drafts.push(...(await createSelectionDrafts(deps, selection, company)));
    else out.draftsDeferred += 1;
  }
  for (const target of saved) {
    if (timeLeft(deps) > DRAFT_TIME_MS) out.drafts.push(...(await draftForContact(deps, target)));
    else out.draftsDeferred += 1;
  }
}

/** A saved contact a draft is written about. */
export interface DraftTarget {
  connectionId: string;
  name: string;
  title: string;
  email?: string;
  company: Pick<QualifiedCompany, "name" | "website" | "description">;
}

/**
 * One personalised draft per member in their OWN Gmail about one contact, written as that member (their profile)
 * and closed with their own signature. Never sends. Already-created drafts are skipped (ledger).
 */
export async function draftForContact(deps: PipelineDeps, t: DraftTarget): Promise<MemberDraftOutcome[]> {
  const brain = brainOf(deps);
  return distributeDrafts(
    { type: "contact", id: t.connectionId, ...(t.email ? { to: t.email } : {}) },
    {
      ...(deps.drafts!.members ? { members: deps.drafts!.members } : {}),
      createDraft: deps.drafts!.createDraft,
      isConnected: deps.drafts!.isConnected,
      ledger: deps.drafts!.ledger,
      compose: async (memberId, memberName) => {
        const d = await brain.writeDraft({
          kind: "outreach",
          member: { id: memberId, name: memberName, ...(deps.config.profiles[memberId] ? { profile: deps.config.profiles[memberId] } : {}) },
          company: { name: t.company.name, ...(t.company.website ? { website: t.company.website } : {}), ...(t.company.description ? { description: t.company.description.slice(0, 400) } : {}) },
          person: { name: t.name, title: t.title },
        });
        const signature = deps.config.signatures?.[memberId];
        return signature ? { ...d, body: `${d.body.trimEnd()}\n\n-- \n${signature}` } : d;
      },
    },
  );
}

async function recordSelection(deps: PipelineDeps, company: QualifiedCompany, out: CompanyOutcome, connectionId: string, p: RankedPerson, assignedTo: MemberId, day: string, at: Date) {
  const s: Selection = { companyKey: company.key, date: day, connectionId, assignedTo, contactName: p.name, ...(p.email ? { email: p.email } : {}), emailStatus: p.email ? p.emailStatus : "unavailable", createdAt: at.toISOString(), draftedFor: [] };
  await deps.selections!.put(s);
  out.selected = { connectionId, name: p.name, assignedTo, ...(p.email ? { email: p.email } : {}), emailStatus: s.emailStatus };
}

/** One personalised draft per member in their OWN Gmail for the selected contact. Never sends. */
export async function createSelectionDrafts(deps: PipelineDeps, selection: Selection, company: Pick<QualifiedCompany, "name" | "website" | "description">, title?: string): Promise<MemberDraftOutcome[]> {
  const role = title ?? (await deps.connections.list()).find((c) => c.connectionId === selection.connectionId)?.role ?? "";
  const outcomes = await draftForContact(deps, { connectionId: selection.connectionId, name: selection.contactName, title: role, ...(selection.email ? { email: selection.email } : {}), company });
  const drafted = [...new Set([...selection.draftedFor, ...outcomes.filter((o) => o.result === "created" || o.result === "already_drafted").map((o) => o.memberId)])];
  if (drafted.length !== selection.draftedFor.length && deps.selections) await deps.selections.put({ ...selection, draftedFor: drafted });
  return outcomes;
}

/** Relevant, fresher-realistic openings of one company → Jobs (as the configured job owner, Anni). */
async function saveCompanyJobs(deps: PipelineDeps, company: QualifiedCompany, out: CompanyOutcome, day: string) {
  const found: JobCandidate[] = [];
  for (const source of deps.jobSources) {
    try {
      found.push(...(await source.findCompanyJobs(company)).map((j) => ({ ...j, companyKey: company.key })));
    } catch (err) {
      out.warnings.push(err instanceof ProviderError ? `${err.provider}: ${err.kind}` : `${source.id}: unexpected error`);
    }
  }
  if (found.length === 0) return;
  await saveJobs(deps, found, out, day);
}

/** Nemotron relevance checks per run for titles the rules cannot place (the rest are left out, not guessed). */
const RELEVANCE_CHECKS_PER_RUN = 10;

interface SaveLimits {
  /** True once enough jobs are saved: nothing more is evaluated (saves Nemotron calls). */
  full?: () => boolean;
  /** A job that must not be taken (e.g. a second opening at the same company). */
  skip?: (j: JobCandidate) => boolean;
  onSaved?: (j: JobCandidate) => void;
}

async function saveJobs(deps: PipelineDeps, found: readonly JobCandidate[], out: Pick<CompanyOutcome, "jobsSaved" | "jobsSkipped">, day: string, limits: SaveLimits = {}) {
  const index = JobIndex.from(await deps.jobs.list());
  const brain = brainOf(deps);
  deps.runState ??= {};
  for (const job of found) {
    if (limits.full?.()) break;
    const employment = classifyEmployment(job.title, job.employment);
    if (employment !== "internship" && employment !== "full_time") {
      out.jobsSkipped.push({ name: job.title, reason: `employment type ${employment}` });
      continue;
    }
    if (limits.skip?.(job)) continue;
    const dup = index.duplicateOf(job);
    if (dup) {
      out.jobsSkipped.push({ name: job.title, reason: `already in Jobs (${dup})` });
      continue;
    }
    // Rules decide clear titles; the brain (Nemotron) only decides titles the rules cannot place, within a budget.
    if (ruleVerdict(job.title).verdict === "unsure") {
      const left = deps.runState.relevanceChecksLeft ?? RELEVANCE_CHECKS_PER_RUN;
      if (left <= 0) {
        out.jobsSkipped.push({ name: job.title, reason: "unclear title; not checked (relevance budget for this run used)" });
        continue;
      }
      deps.runState.relevanceChecksLeft = left - 1;
    }
    const verdict = await brain.isRelevantJob(job);
    if (!verdict.relevant) {
      out.jobsSkipped.push({ name: job.title, reason: verdict.reason });
      continue;
    }
    try {
      const res = await deps.jobs.create(deps.config.jobOwner, toJobInput(job, day));
      index.add(job);
      if ("created" in res) {
        out.jobsSaved.push(job.title);
        limits.onSaved?.(job);
      } else out.jobsSkipped.push({ name: job.title, reason: "already in Jobs (url)" });
    } catch (err) {
      if (err instanceof Error && err.name === "ZodError") out.jobsSkipped.push({ name: job.title, reason: "invalid posting data" });
      else throw err;
    }
  }
}

// ---- scheduler tick -------------------------------------------------------------------------------------

export type TickResult =
  | { ran: false; reason: "disabled" | "outside_window" | "batch_complete" }
  | { ran: false; reason: "contact_limit"; contacts: number; limit: number }
  | { ran: false; reason: "paused"; resumeAt?: number; pauseReason?: string }
  | { ran: true; window: ActiveWindow; processed: CompanyOutcome[]; remaining: number; discovery?: DiscoveryResult; pausedUntil?: number; failed: string[]; notified?: boolean };

/** Notifies all three members once per local day that the contact limit is reached. No export, no deletion. */
async function notifyContactLimit(deps: PipelineDeps, day: string, count: number): Promise<void> {
  const key = `${day}#limit-notified`;
  if (!deps.notifier || (await deps.ledger.get(key)) > 0) return;
  await deps.ledger.add(key, 1);
  await deps.notifier.notifyTeam({
    title: `Network Finder paused: ${count} connections`,
    body: `Connections reached the ${deps.config.contactLimit}-contact limit. No new contacts will be added until you export or tidy the list yourself. Nothing was exported or deleted.`,
    tag: `nf-limit-${day}`,
  });
}

/**
 * One scheduler call inside a batch window: tops up the queue from discovery if needed, then processes up to
 * `maxCompaniesPerTick` companies. When the window's 10 companies are done (or no more can be found), ONE
 * summary notification goes to the team.
 */
export async function runBatchTick(deps: PipelineDeps): Promise<TickResult> {
  if (!deps.config.enabled) return { ran: false, reason: "disabled" };
  const at = now(deps);
  const window = activeWindow(at, deps.config.timeZone);
  if (!window) return { ran: false, reason: "outside_window" };
  const count = (await deps.connections.list()).length;
  if (count >= deps.config.contactLimit) {
    await notifyContactLimit(deps, window.date, count);
    return { ran: false, reason: "contact_limit", contacts: count, limit: deps.config.contactLimit };
  }
  const state = await deps.queue.state(at.getTime());
  if (state.paused) return { ran: false, reason: "paused", resumeAt: state.pausedUntil, pauseReason: state.reason };
  let remaining = deps.config.batchSize - (await deps.ledger.get(window.key));
  if (remaining <= 0) return { ran: false, reason: "batch_complete" };

  const result: Extract<TickResult, { ran: true }> = { ran: true, window, processed: [], remaining, failed: [] };
  if (state.pending < remaining) result.discovery = await discoverCompanies(deps, remaining - state.pending);

  for (let i = 0; i < deps.config.maxCompaniesPerTick && remaining > 0; i++) {
    // Not enough time left in this run for a whole company: it stays queued for the next run.
    if (timeLeft(deps) < COMPANY_TIME_MS) break;
    const t = now(deps).getTime();
    const item = await deps.queue.claim(t);
    if (!item) break;
    try {
      const out = await processCompany(deps, item.payload.company);
      result.processed.push(out);
      await deps.queue.complete(item.id);
      remaining = deps.config.batchSize - (await deps.ledger.add(window.key, 1));
      await deps.ledger.add(`${window.key}#contacts`, out.contactsSaved.length);
      await deps.ledger.add(`${window.key}#jobs`, out.jobsSaved.length);
      await deps.ledger.add(`${window.key}#selected`, out.selected ? 1 : 0);
      await deps.ledger.add(`${window.key}#drafts`, (out.drafts ?? []).filter((d) => d.result === "created").length);
      if (out.limitReached) {
        await notifyContactLimit(deps, window.date, (await deps.connections.list()).length);
        break;
      }
    } catch (err) {
      if (err instanceof ApolloPoolExhausted) {
        // Only reachable if a future step makes Apollo mandatory again; today Apollo problems are warnings.
        await deps.queue.retry(item.id, t, Math.max(0, err.resumeAt - t), "apollo_exhausted", { countAttempt: false });
        await deps.queue.pause(err.resumeAt, "apollo_exhausted");
        result.pausedUntil = err.resumeAt;
        break;
      }
      const reason = err instanceof ProviderError ? `${err.provider}: ${err.kind}` : err instanceof Error ? err.name : "error";
      // A site's rate limit is not the company's fault: wait as asked, without using up an attempt.
      const rateLimited = err instanceof ProviderError && err.kind === "rate_limited";
      const status = await deps.queue.retry(item.id, t, err instanceof ProviderError && err.retryAt ? Math.max(0, err.retryAt - t) : backoffDelay(item.attempts + 1), reason, rateLimited ? { countAttempt: false } : {});
      if (status === "failed") {
        result.failed.push(item.payload.company.key);
        const rec = await deps.registry.get(item.payload.company.key);
        if (rec) await deps.registry.put({ ...rec, status: "failed" });
      }
    }
  }
  result.remaining = remaining;

  // One summary per batch window: when its 10 are done, or when nothing more can be found for it.
  const doneCount = await deps.ledger.get(window.key);
  const exhausted = remaining > 0 && result.processed.length === 0 && (result.discovery?.enqueued.length ?? 0) === 0 && (await deps.queue.state(now(deps).getTime())).pending === 0;
  if (deps.notifier && doneCount > 0 && (remaining <= 0 || exhausted) && (await deps.ledger.get(`${window.key}#notified`)) === 0) {
    await deps.ledger.add(`${window.key}#notified`, 1);
    const [contacts, jobs, selected, drafts] = await Promise.all(["contacts", "jobs", "selected", "drafts"].map((k) => deps.ledger.get(`${window.key}#${k}`)));
    await deps.notifier.notifyTeam({
      title: `Network Finder batch ${window.index + 1}/${BATCH_WINDOWS.length}: ${doneCount} ${doneCount === 1 ? "company" : "companies"}${remaining > 0 ? " (partial)" : ""}`,
      body: `${contacts} new contacts, ${selected} selected for outreach, ${drafts} Gmail drafts created, ${jobs} jobs added. Nothing was sent.`,
      tag: `nf-batch-${window.key}`,
    });
    result.notified = true;
  }
  return result;
}

/**
 * Completes the drafts that earlier runs could not create or had no time for: every Network Finder contact of the
 * last `days` days that is still "Not Connected" gets a draft in each CONNECTED member's mailbox (a member who
 * connects Gmail later therefore receives the recent drafts too). Today's selections go first, then the oldest.
 * Members without Gmail are not touched (no ledger writes every run); failures are retried on later runs.
 */
export async function runPendingDrafts(deps: PipelineDeps, options: { days?: number; limit?: number } = {}): Promise<{ checked: number; created: number; remaining: number }> {
  const none = { checked: 0, created: 0, remaining: 0 };
  if (!deps.drafts) return none;
  const all = deps.drafts.members ?? MEMBER_IDS;
  const members: MemberId[] = [];
  for (const m of all) if (await deps.drafts.isConnected(m)) members.push(m);
  if (members.length === 0) return none;

  const cutoff = new Date(now(deps).getTime() - (options.days ?? 3) * 86_400_000).toISOString();
  const snapshot = deps.drafts.snapshot ? new Map(await deps.drafts.snapshot()) : null;
  const done = async (connectionId: string, m: MemberId) => {
    const key = draftKey({ type: "contact", id: connectionId }, m);
    return (snapshot ? snapshot.get(key) : await deps.drafts!.ledger.get(key))?.status === "created";
  };
  const selections = deps.selections ? await deps.selections.all() : [];
  const selectedIds = new Map(selections.map((s) => [s.connectionId, s]));
  const contacts = (await deps.connections.list())
    .filter((c) => isNetworkFinderEntry(c) && c.status === "Not Connected" && c.createdAt >= cutoff)
    .sort((a, b) => Number(selectedIds.has(b.connectionId)) - Number(selectedIds.has(a.connectionId)) || a.createdAt.localeCompare(b.createdAt));
  const pending: Connection[] = [];
  for (const c of contacts) {
    for (const m of members) {
      if (!(await done(c.connectionId, m))) {
        pending.push(c);
        break;
      }
    }
  }

  const registry = await deps.registry.all();
  const companyOf = (c: Connection) => {
    const s = selectedIds.get(c.connectionId);
    const rec = (s && registry.find((r) => r.key === s.companyKey)) || registry.find((r) => r.name.trim().toLowerCase() === (c.company ?? "").trim().toLowerCase());
    return { name: rec?.name ?? c.company ?? "", ...(rec?.website ? { website: rec.website } : {}) };
  };
  // Drafting only for connected members; the snapshot keeps the ledger reads to one per run.
  const runDeps: PipelineDeps = {
    ...deps,
    drafts: {
      ...deps.drafts,
      members,
      ledger: {
        get: async (key) => (snapshot ? snapshot.get(key) : deps.drafts!.ledger.get(key)),
        record: async (e) => {
          await deps.drafts!.ledger.record(e);
          snapshot?.set(e.draftKey, { status: e.status });
        },
      },
    },
  };
  const result = { checked: 0, created: 0, remaining: pending.length };
  for (const c of pending.slice(0, options.limit ?? 5)) {
    if (timeLeft(deps) < DRAFT_TIME_MS) break;
    const s = selectedIds.get(c.connectionId);
    const outcomes = s
      ? await createSelectionDrafts(runDeps, s, companyOf(c), c.role ?? "")
      : await draftForContact(runDeps, { connectionId: c.connectionId, name: c.name, title: c.role ?? "", ...(c.email ? { email: c.email } : {}), company: companyOf(c) });
    result.checked += 1;
    result.remaining -= 1;
    result.created += outcomes.filter((o) => o.result === "created").length;
  }
  return result;
}

// ---- re-checks and the daily job search ------------------------------------------------------------------

/** Re-checks previously processed companies for NEW openings (no new contacts, no Apollo credits). */
export async function recheckCompanyJobs(deps: PipelineDeps, limit: number): Promise<{ checked: number; jobsSaved: string[]; warnings: string[] }> {
  const at = now(deps);
  const day = dateInTimezone(at, deps.config.timeZone);
  const due = dueForJobRecheck(await deps.registry.all(), at.getTime(), deps.config.jobRecheckIntervalMs).slice(0, limit);
  const total = { checked: 0, jobsSaved: [] as string[], warnings: [] as string[] };
  for (const rec of due) {
    const company = { ...rec, key: rec.key, regionGroup: rec.country === "US" ? "us" : "international", score: 0 } as QualifiedCompany;
    const out: CompanyOutcome = { companyKey: rec.key, peopleFound: 0, contactsSaved: [], contactsSkipped: [], jobsSaved: [], jobsSkipped: [], warnings: [] };
    await saveCompanyJobs(deps, company, out, day);
    await deps.registry.put({ ...rec, lastJobCheckAt: at.toISOString(), jobsSaved: rec.jobsSaved + out.jobsSaved.length });
    total.checked += 1;
    total.jobsSaved.push(...out.jobsSaved);
    total.warnings.push(...out.warnings);
  }
  return total;
}

/**
 * The daily extra search: up to N internships and N full-time openings across DIFFERENT companies, from job
 * sources that support searching. Remote first, then best match. Counted per local day so repeated calls never
 * exceed the targets.
 */
export async function runDailyJobSearch(deps: PipelineDeps): Promise<{ internships: string[]; fullTime: string[]; warnings: string[] }> {
  const at = now(deps);
  const day = dateInTimezone(at, deps.config.timeZone);
  const result = { internships: [] as string[], fullTime: [] as string[], warnings: [] as string[] };
  const plan = [
    { employment: "internship" as const, target: deps.config.dailyInternships, key: `${day}#jobs-internship`, into: result.internships },
    { employment: "full_time" as const, target: deps.config.dailyFullTime, key: `${day}#jobs-full-time`, into: result.fullTime },
  ];
  for (const step of plan) {
    const left = step.target - (await deps.ledger.get(step.key));
    if (left <= 0) continue;
    const found: JobCandidate[] = [];
    for (const source of deps.jobSources) {
      if (!source.searchJobs) continue;
      try {
        found.push(...(await source.searchJobs({ keywords: TARGET_ROLES, employment: step.employment, limit: left * 4 })));
      } catch (err) {
        result.warnings.push(err instanceof ProviderError ? `${err.provider}: ${err.kind}` : `${source.id}: unexpected error`);
      }
    }
    // Remote first, then best match; one opening per company.
    const ranked = found
      .filter((j) => classifyEmployment(j.title, j.employment) === step.employment)
      .sort((a, b) => Number(Boolean(b.remote)) - Number(Boolean(a.remote)) || matchRole(b.title).score - matchRole(a.title).score);
    const companies = new Set<string>();
    const company = (j: JobCandidate) => j.companyName.trim().toLowerCase();
    const out = { jobsSaved: [] as string[], jobsSkipped: [] as Skip[] };
    await saveJobs(deps, ranked, out, day, {
      full: () => out.jobsSaved.length >= left,
      skip: (j) => companies.has(company(j)),
      onSaved: (j) => companies.add(company(j)),
    });
    if (out.jobsSaved.length) await deps.ledger.add(step.key, out.jobsSaved.length);
    step.into.push(...out.jobsSaved);
  }
  return result;
}
