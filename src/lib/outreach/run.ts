/**
 * One outreach cycle: register manual connections, import today's share of the Outreach Database, run the existing drafting
 * worker (so imported and manual connections go through the SAME pipeline), then sync statuses and counters. Every step is
 * idempotent, so a cron retry or an interrupted run simply continues. It cannot send email (see send-gate.ts).
 */
import { MEMBER_IDS, type MemberId } from "@/config/members";
import { createGoogleClient, sheetsRateLimitHits } from "@/lib/google-sheets/client";
import { loadSheetsConfig } from "@/lib/google-sheets/config";
import { createConnection } from "@/lib/google-sheets/connections-service";
import { readConnectionsLocated } from "@/lib/google-sheets/repositories";
import { isGmailConnected } from "@/lib/gmail/drafts";
import { readDraftLedger, recordDraft, readGmailAccounts } from "@/lib/gmail/store";
import { reconcileDraftSend, readDraftFor, sendDraftFor } from "@/lib/gmail/send";
import { existingResumes } from "@/lib/network-finder/gateways";
import { updateConnection } from "@/lib/google-sheets/connections-service";
import { buildRealDeps } from "@/lib/network-finder/run";
import { runPendingDrafts } from "@/lib/network-finder/pipeline";
import { resolveTimezone } from "@/lib/utils/time";
import { createConnectionSchema } from "@/lib/validation/connections";
import { loadOutreachConfig, type OutreachConfig } from "./config";
import { firstInDuplicateGroups, importEligibility, parseMasterRows } from "./contacts";
import { runOutreachImport, type ConnectionsPort, type ImportResult } from "./importer";
import { registerManualConnections } from "./manual";
import { OutreachSheet } from "./sheet";
import { computeCounters, syncTracking, todayOf, type LedgerEntry } from "./sync";
import { announceConnectionMilestones, announceSentBlocks, type NotifyAll } from "./announce";
import { notifyEveryone } from "@/lib/push/notify";
import { runSendStep, type SendDeps, type SendRunResult } from "./send-workflow";
import { SENDING_ENABLED, type DailyCounters } from "./types";

/** Longer than the route's 60 s limit, so a run that is killed never holds the lock past the next call; a normal run releases it at once. */
export const OUTREACH_LOCK_TTL_MS = 65_000;
/** When Google answers 429 this often within one run, drafting (the slowest step) yields for this run; sending and importing already ran. */
export const DRAFT_YIELD_AFTER_RATE_LIMITS = 8;

export interface CycleDeps {
  config: OutreachConfig;
  sheet: Pick<OutreachSheet, "ensureTabs" | "readMaster" | "readTracking" | "appendTracking" | "updateTracking" | "upsertCounters" | "acquireLock" | "releaseLock" | "readSendLedger" | "claimMilestone" | "completeMilestone" | "releaseMilestone" | "claimedMilestones" | "setState">;
  connections: ConnectionsPort;
  ledger(): Promise<ReadonlyMap<string, LedgerEntry>>;
  connected(): Promise<MemberId[]>;
  /** The existing drafting worker (same one the Network Finder cron runs). Absent = skip drafting this call. */
  draft?: (limit: number) => Promise<{ checked: number; created: number; remaining: number } | "busy">;
  /** The send step. Only ever called when `gate` is true; the real wiring does not even construct it while the gate is closed. */
  send?: () => Promise<SendRunResult>;
  /** Delivers a system notification to every member's devices ("10 connections added", "10 emails sent"). Absent = no notifications. */
  notify?: NotifyAll;
  /** Defaults to the compile-time SENDING_ENABLED (false). Tests pass true together with MOCK ports. */
  gate?: boolean;
  now: () => Date;
  timezone: string;
  deadline?: number;
  /** Number of Sheets 429 responses seen so far in this run (absent = never yield). */
  rateLimitHits?: () => number;
}

export interface CycleResult {
  ran: boolean;
  reason?: "disabled" | "busy";
  manual?: { registered: number; alreadyTracked: number; skipped: number };
  import?: ImportResult;
  drafts?: { checked: number; created: number; remaining: number } | "busy" | "skipped";
  send?: SendRunResult;
  announced?: { connections: number; sentBlocks: number };
  counters?: DailyCounters;
  errors: string[];
}

export async function runOutreachCycle(deps: CycleDeps): Promise<CycleResult> {
  if (!deps.config.enabled) return { ran: false, reason: "disabled", errors: [] };
  const t = deps.now().getTime();
  if (!(await deps.sheet.acquireLock(t, OUTREACH_LOCK_TTL_MS))) return { ran: false, reason: "busy", errors: [] };
  const result: CycleResult = { ran: true, errors: [] };
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      result.errors.push(`${name}: ${err instanceof Error ? err.name : "error"}`);
      return undefined;
    }
  };
  try {
    await deps.sheet.ensureTabs();
    result.manual = await step("manual", () => registerManualConnections({ sheet: deps.sheet, connections: deps.connections, now: deps.now, since: deps.config.manualSince }));
    // Sending runs FIRST with its own time slice, so slow drafting or Sheets back-off can never starve it.
    const gate: boolean = deps.gate ?? SENDING_ENABLED;
    if (gate && deps.send) result.send = await step("send", deps.send);
    else result.send = { status: "disabled", sent: 0, blocked: 0, needsReview: 0, failed: 0, waiting: 0, duplicatesPrevented: 0, reconciled: 0, stoppedBecause: "none", errors: [] };
    result.import = await step("import", () =>
      runOutreachImport({ sheet: deps.sheet, connections: deps.connections, now: deps.now, timezone: deps.timezone, dailyLimit: deps.config.dailyLimit, perRun: deps.config.perRun, ownerOverride: deps.config.ownerOverride, staleClaimMs: 120_000, ...(deps.deadline ? { deadline: deps.deadline } : {}) }),
    );
    const pressured = (deps.rateLimitHits?.() ?? 0) >= DRAFT_YIELD_AFTER_RATE_LIMITS;
    result.drafts = deps.draft && !pressured ? ((await step("drafts", () => deps.draft!(deps.config.draftsPerRun))) ?? "skipped") : "skipped";
    const sync = () =>
      step("sync", async () => {
        const connections = await deps.connections.listFresh();
        await syncTracking({ sheet: deps.sheet, ledger: await deps.ledger(), connected: await deps.connected(), connections, now: deps.now });
      });
    await sync();
    // System notifications to all three members: only AFTER the work they describe is saved and confirmed in the ledgers.
    if (deps.notify) {
      const notify = deps.notify;
      const ctx = { sheet: deps.sheet, notify, now: deps.now };
      const added = await step("announce-connections", () => announceConnectionMilestones(ctx));
      const blocks = await step("announce-sent", () => announceSentBlocks(ctx));
      result.announced = { connections: added?.announced ?? 0, sentBlocks: blocks?.announced ?? 0 };
    }
    await step("counters", async () => {
      const { records } = await deps.sheet.readTracking();
      const { records: ledger } = await deps.sheet.readSendLedger();
      const parsed = parseMasterRows(await deps.sheet.readMaster());
      const tracked = new Set(records.map((r) => r.contactId));
      const first = firstInDuplicateGroups(parsed.contacts);
      const remaining = parsed.contacts.filter((c) => !tracked.has(c.contactId) && importEligibility(c, first).eligible).length;
      result.counters = computeCounters(records, todayOf(deps.now(), deps.timezone), remaining, { ledger, masterIds: new Set(parsed.contacts.map((c) => c.contactId)) });
      await deps.sheet.upsertCounters(result.counters, deps.now().toISOString());
    });
  } catch (err) {
    result.errors.push(`setup: ${err instanceof Error ? err.message.slice(0, 160) : "error"}`);
  } finally {
    await deps.sheet.releaseLock(deps.now().getTime()).catch(() => undefined);
  }
  return result;
}

/** The OutreachSheet on the Outreach Database spreadsheet, with the app's existing service-account credentials. Never the production sheet. */
export function openOutreachSheet(config: OutreachConfig = loadOutreachConfig()): OutreachSheet {
  const base = loadSheetsConfig();
  if (!config.spreadsheetId) throw new Error("OUTREACH_SPREADSHEET_ID is not set.");
  if (config.spreadsheetId === base.spreadsheetId) throw new Error("OUTREACH_SPREADSHEET_ID must not be the production spreadsheet.");
  return new OutreachSheet(createGoogleClient({ ...base, spreadsheetId: config.spreadsheetId }), config.masterTab, config.spreadsheetId);
}

export const realConnectionsPort: ConnectionsPort = {
  listFresh: async () => (await readConnectionsLocated({ fresh: true })).items.map((i) => i.value),
  create: (owner, input) => createConnection(owner, createConnectionSchema.parse(input), new Date(), { notify: false }),
};

/** The real Gmail send wiring. Constructed ONLY when the compile-time gate is open (never in the shipped state). */
export function buildRealSendDeps(config: OutreachConfig, sheet: OutreachSheet, timezone: string, deadline?: number): SendDeps {
  return {
    gate: SENDING_ENABLED,
    sheet,
    gmail: {
      address: async (m) => (await readGmailAccounts({ fresh: true })).find((a) => a.memberId === m && a.status === "connected")?.email ?? null,
      readDraft: (m, id) => readDraftFor(m, id),
      send: (m, id) => sendDraftFor(m, id),
      reconcile: (m, id, thread) => reconcileDraftSend(m, id, thread),
    },
    resumes: existingResumes,
    connections: {
      listFresh: realConnectionsPort.listFresh,
      markMessaged: async (c) => {
        await updateConnection(c.memberId, c.connectionId, { status: "Messaged" });
      },
    },
    drafts: {
      snapshot: async () => new Map([...(await readDraftLedger({ fresh: true })).entries()].map(([k, v]) => [k, { status: v.status, detail: v.detail, gmailDraftId: v.gmailDraftId, ...(v.threadId ? { threadId: v.threadId } : {}) }])),
      markSent: async (m, connectionId) => {
        const current = (await readDraftLedger({ fresh: true })).get(`contact:${connectionId}:${m}`);
        if (current) await recordDraft({ ...current, status: "sent", checkedAt: new Date().toISOString() });
      },
    },
    limits: config.sendLimits,
    allowlist: config.sendAllowlist,
    now: () => new Date(),
    timezone,
    ...(deadline ? { deadline } : {}),
  };
}

export function buildRealCycleDeps(config: OutreachConfig = loadOutreachConfig(), env: NodeJS.ProcessEnv = process.env, budgetMs = 44_000): CycleDeps {
  const started = Date.now();
  const sheet = openOutreachSheet(config);
  const timezone = resolveTimezone(env.APP_TIMEZONE);
  const gate: boolean = SENDING_ENABLED;
  return {
    config,
    sheet,
    gate,
    notify: async (payload, key) => ((await notifyEveryone(payload, key)).status === "unreadable" ? "retry" : "done"),
    // The send step is only built when the compile-time gate is open. In the shipped state this is undefined.
    ...(gate ? { send: () => runSendStep(buildRealSendDeps(config, sheet, timezone, started + 20_000)) } : {}),
    connections: realConnectionsPort,
    ledger: async () => new Map([...(await readDraftLedger({ fresh: true })).entries()].map(([k, v]) => [k, { status: v.status, detail: v.detail, gmailDraftId: v.gmailDraftId, ...(v.threadId ? { threadId: v.threadId } : {}) }])),
    connected: async () => {
      const out: MemberId[] = [];
      for (const m of MEMBER_IDS) if (await isGmailConnected(m)) out.push(m);
      return out;
    },
    draft: async (limit) => {
      // Same single-run lock as the Network Finder cron, so two workers never draft the same connection at once.
      const nf = buildRealDeps();
      const at = Date.now();
      if (!(await nf.stores.acquireRunLock(at, 75_000))) return "busy";
      nf.runState = { ...nf.runState, deadline: started + budgetMs };
      try {
        return await runPendingDrafts(nf, { limit });
      } finally {
        await nf.stores.releaseRunLock().catch(() => undefined);
      }
    },
    now: () => new Date(),
    timezone,
    deadline: started + budgetMs - 8_000,
    rateLimitHits: sheetsRateLimitHits,
  };
}

/** Counts only: no names, e-mails or draft text leave the server in a cron response. */
export function summarizeCycle(r: CycleResult) {
  return {
    ran: r.ran,
    manual: r.manual ?? null,
    import: r.import ? { ...r.import } : null,
    drafts: r.drafts ?? null,
    send: r.send ? { ...r.send } : null,
    announced: r.announced ?? null,
    counters: r.counters ?? null,
    errors: r.errors,
  };
}
