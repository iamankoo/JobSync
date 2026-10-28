import "server-only";
import { setSheetsRetryDeadline } from "@/lib/google-sheets/client";
import { ApolloPool, enabledApolloAccounts } from "./apollo-pool";
import { loadNetworkFinderConfig, type NetworkFinderConfig } from "./config";
import { ApolloPoolExhausted, ProviderError } from "./errors";
import { existingConnections, existingDraftDeps, existingJobs, existingSentTrackerDeps, teamNotifier } from "./gateways";
import { PoliteFetcher } from "./http/polite-fetch";
import { recheckCompanyJobs, runBatchTick, runDailyJobSearch, runPendingDrafts, type PipelineDeps, type TickResult } from "./pipeline";
import { createApolloProvider } from "./providers/apollo";
import { createApolloOrgProvider } from "./providers/apollo-org";
import { createCompanyResearcher } from "./company-research";
import { createCompanyFactsFinder } from "./providers/company-facts";
import { createArbeitnowSource, createCompanyBoardSource, createRemoteOkSource } from "./providers/job-boards";
import { createNemotronBrain, createNemotronCompanyFactsExtractor, createNemotronPeopleExtractor, loadNemotronConfig } from "./providers/nemotron";
import { createHnHiringSource, createRemoteInTechSource } from "./providers/public-sources";
import { createWebsiteContactFinder } from "./providers/website-contacts";
import { runSentTracking, type SentTrackingResult } from "./sent-tracker";
import { createSheetsStores } from "./sheets-stores";
import type { CompanyCandidate } from "./types";

/** The cron function may run 60 s; the run wraps up with this much margin. */
export const RUN_BUDGET_MS = 50_000;
/**
 * How long the run lock holds. A run that Vercel kills at 60 s never reaches its `finally`, so the lock must expire
 * soon after the longest possible run — NOT minutes later (28 Oct: a 5-minute TTL made every killed run block the
 * next scheduled call with 409, so only about one call in three could do any work).
 */
export const RUN_LOCK_TTL_MS = 75_000;
/** Latest moment (after the run starts) the lock release may still retry a rate-limited write. */
const RELEASE_WINDOW_MS = 57_000;

type Enricher = (c: CompanyCandidate) => Promise<CompanyCandidate | null>;
type FactsFinder = Pick<ReturnType<typeof createCompanyFactsFinder>, "find">;

/**
 * Missing size / country, from real sources only, in order:
 *  1. Apollo organization enrich (optional; works on the Free plan) — a refusal or exhausted quota switches it
 *     off for the rest of the run and the free step below still runs;
 *  2. the company's own pages (an explicit size / headquarters sentence, found by rules or Nemotron and re-checked).
 */
export function chainEnrichers(apollo: Enricher | undefined, facts: FactsFinder | undefined): Enricher | undefined {
  if (!apollo && !facts) return undefined;
  let apolloOff = false;
  return async (c) => {
    let out: CompanyCandidate = c;
    if (apollo && !apolloOff) {
      try {
        const e = await apollo(c);
        if (e) out = { ...out, ...(out.employeeCount === undefined && e.employeeCount !== undefined ? { employeeCount: e.employeeCount } : {}), ...(!out.countryCode && e.countryCode ? { countryCode: e.countryCode } : {}), ...(e.apolloOrgId ? { apolloOrgId: e.apolloOrgId } : {}), ...(!out.description && e.description ? { description: e.description } : {}) };
      } catch (err) {
        if (!(err instanceof ApolloPoolExhausted || (err instanceof ProviderError && err.provider === "apollo"))) throw err;
        apolloOff = true;
      }
    }
    if (facts && (out.employeeCount === undefined || !out.countryCode)) {
      const f = await facts.find(out);
      if (f) out = { ...out, ...(out.employeeCount === undefined && f.employeeCount !== undefined ? { employeeCount: f.employeeCount } : {}), ...(!out.countryCode && f.countryCode ? { countryCode: f.countryCode } : {}), factsSource: f.source };
    }
    return out === c ? null : out;
  };
}

/**
 * The real wiring for one scheduled run (cron-job.org → /api/cron/network-finder). Free public sources do the
 * work; Apollo is used only for the accounts enabled (default: account 1) AND only where its plan allows.
 * Nothing here can send an email.
 */
export function buildRealDeps(config: NetworkFinderConfig = loadNetworkFinderConfig(), env: NodeJS.ProcessEnv = process.env): PipelineDeps & { stores: ReturnType<typeof createSheetsStores> } {
  const stores = createSheetsStores();
  const fetcher = new PoliteFetcher();
  const nemotron = loadNemotronConfig(env);
  const accounts = enabledApolloAccounts(env);
  const pool = accounts.length ? new ApolloPool(accounts, stores.apolloUsage) : undefined;
  const org = pool ? createApolloOrgProvider(pool) : undefined;
  const apolloEnrich: Enricher | undefined = org ? (c) => (c.website ? org.enrichByDomain(new URL(c.website).hostname.replace(/^www\./, ""), c.source, c.sourceUrl) : Promise.resolve(null)) : undefined;
  const facts = createCompanyFactsFinder(fetcher, nemotron ? createNemotronCompanyFactsExtractor(nemotron) : null);
  const boards = createCompanyBoardSource(fetcher);
  const built: PipelineDeps & { stores: ReturnType<typeof createSheetsStores> } = {
    stores,
    config,
    sources: [createHnHiringSource(fetcher), createRemoteInTechSource(fetcher)],
    contactFinders: [createWebsiteContactFinder(fetcher, nemotron ? createNemotronPeopleExtractor(nemotron) : null)],
    ...(pool ? { pool, contacts: createApolloProvider() } : {}),
    enrichCompany: chainEnrichers(apolloEnrich, facts),
    ...(nemotron ? { brain: createNemotronBrain(nemotron) } : {}),
    jobSources: [boards, createRemoteOkSource(fetcher), createArbeitnowSource(fetcher)],
    research: createCompanyResearcher(fetcher, boards, { deadline: () => built.runState?.deadline }),
    queue: stores.queue,
    registry: stores.registry,
    ledger: stores.ledger,
    selections: stores.selections,
    drafts: existingDraftDeps(),
    notifier: teamNotifier,
    connections: existingConnections,
    jobs: existingJobs,
    runState: {},
  };
  return built;
}

export interface CycleResult {
  ran: boolean;
  reason?: "disabled" | "busy";
  sentTracking?: SentTrackingResult;
  batch?: TickResult;
  manualDrafts?: { checked: number; created: number; remaining: number };
  pendingDrafts?: { checked: number; created: number; remaining: number };
  dailyJobs?: { internships: string[]; fullTime: string[]; warnings: string[] };
  recheck?: { checked: number; jobsSaved: string[]; warnings: string[] };
  errors: string[];
}

/** One scheduled cycle. Each step is independent: one failing does not stop the others. */
export async function runScheduledCycle(deps: PipelineDeps & { stores: ReturnType<typeof createSheetsStores> } = buildRealDeps(), budgetMs = RUN_BUDGET_MS): Promise<CycleResult> {
  if (!deps.config.enabled) return { ran: false, reason: "disabled", errors: [] };
  const at = Date.now();
  if (!(await deps.stores.acquireRunLock(at, RUN_LOCK_TTL_MS))) return { ran: false, reason: "busy", errors: [] };
  deps.runState = { ...deps.runState, deadline: at + budgetMs };
  // Rate-limited Sheets calls stop retrying at the run's deadline instead of sleeping past the function's time limit.
  setSheetsRetryDeadline(at + budgetMs);
  const result: CycleResult = { ran: true, errors: [] };
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      result.errors.push(`${name}: ${err instanceof ProviderError ? `${err.provider} ${err.kind}` : err instanceof Error ? err.name : "error"}`);
      return undefined;
    }
  };
  const hasTime = (ms: number) => deps.runState!.deadline! - Date.now() > ms;
  try {
    result.sentTracking = await step("sent-tracking", () => runSentTracking(existingSentTrackerDeps(), 30));
    // Manually added connections first (one per call), so they are drafted within ~10 minutes even during a batch.
    result.manualDrafts = await step("manual-drafts", () => runPendingDrafts(deps, { limit: 1, manualOnly: true }));
    result.batch = await step("batch", () => runBatchTick(deps));
    result.pendingDrafts = await step("pending-drafts", () => runPendingDrafts(deps, { limit: 6 }));
    if (hasTime(15_000)) result.dailyJobs = await step("daily-jobs", () => runDailyJobSearch(deps));
    if (hasTime(15_000)) result.recheck = await step("recheck", () => recheckCompanyJobs(deps, 2));
  } finally {
    setSheetsRetryDeadline(at + RELEASE_WINDOW_MS);
    await deps.stores.releaseRunLock().catch(() => undefined);
    setSheetsRetryDeadline(null);
  }
  return result;
}

/**
 * What the cron endpoint returns: COUNTS only. No names, emails, companies or draft text leave the server in
 * the response (cron-job.org keeps response bodies in its history).
 */
export function summarizeCycle(r: CycleResult) {
  const b = r.batch;
  return {
    ran: r.ran,
    sentTracking: r.sentTracking ? { checked: r.sentTracking.checked, sent: r.sentTracking.sent.length, markedMessaged: r.sentTracking.markedMessaged.length, deleted: r.sentTracking.deleted, stillDrafts: r.sentTracking.stillDrafts, unknown: r.sentTracking.unknown } : null,
    batch: !b
      ? null
      : !b.ran
        ? { ran: false, reason: b.reason }
        : {
            ran: true,
            window: b.window.index + 1,
            companiesProcessed: b.processed.length,
            contactsSaved: b.processed.reduce((n, o) => n + o.contactsSaved.length, 0),
            selected: b.processed.filter((o) => o.selected).length,
            draftsCreated: b.processed.reduce((n, o) => n + (o.drafts ?? []).filter((d) => d.result === "created").length, 0),
            draftsDeferred: b.processed.reduce((n, o) => n + (o.draftsDeferred ?? 0), 0),
            jobsSaved: b.processed.reduce((n, o) => n + o.jobsSaved.length, 0),
            remainingInWindow: b.remaining,
            discovered: b.discovery ? { enqueued: b.discovery.enqueued.length, rejected: b.discovery.rejected, alreadyKnown: b.discovery.alreadyKnown, errors: b.discovery.errors.length } : null,
            failed: b.failed.length,
            warnings: [...new Set(b.processed.flatMap((o) => o.warnings))],
            notified: Boolean(b.notified),
          },
    manualDrafts: r.manualDrafts ?? null,
    pendingDrafts: r.pendingDrafts ?? null,
    dailyJobs: r.dailyJobs ? { internships: r.dailyJobs.internships.length, fullTime: r.dailyJobs.fullTime.length, warnings: r.dailyJobs.warnings } : null,
    recheck: r.recheck ? { checked: r.recheck.checked, jobsSaved: r.recheck.jobsSaved.length } : null,
    errors: r.errors,
  };
}
