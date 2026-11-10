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
import { getDraftBacklogGate } from "@/lib/gmail/draft-backlog";
import { withParkedReason } from "@/lib/gmail/draft-flags";
import { reconcileDraftSend, readDraftFor, sendDraftFor } from "@/lib/gmail/send";
import { existingResumes } from "@/lib/network-finder/gateways";
import { updateConnection } from "@/lib/google-sheets/connections-service";
import { buildRealDeps } from "@/lib/network-finder/run";
import { runPendingDrafts } from "@/lib/network-finder/pipeline";
import { resolveTimezone } from "@/lib/utils/time";
import { createConnectionSchema } from "@/lib/validation/connections";
import { loadOutreachConfig, type OutreachConfig } from "./config";
import { eligibleIdSet, firstInDuplicateGroups, importEligibility, parseMasterRows } from "./contacts";
import { resolvePriorityContacts } from "./priority";
import { runOutreachImport, type ConnectionsPort, type ImportResult } from "./importer";
import { adoptExistingDrafts, type AdoptResult } from "./existing-drafts";
import { registerManualConnections } from "./manual";
import { OutreachSheet } from "./sheet";
import { computeCounters, syncTracking, todayOf, type LedgerEntry } from "./sync";
import { announceConnectionMilestones, announceSentBlocks, type NotifyAll } from "./announce";
import { runGmailHealth, type GmailHealthDeps, type GmailHealthResult } from "./gmail-health";
import { notifyEveryone, notifyMember } from "@/lib/push/notify";
import { runSendStep, type SendDeps, type SendRunResult } from "./send-workflow";
import { SENDING_ENABLED, type DailyCounters } from "./types";

/** Longer than the route's 60 s limit, so a run that is killed never holds the lock past the next call; a normal run releases it at once. */
export const OUTREACH_LOCK_TTL_MS = 65_000;
/** Contacts that need a person (review / blocked / recorded as unsendable) are re-checked about every 30 minutes (every 15th call), not on every call (see SendDeps.reviewRecheckEvery). */
export const REVIEW_RECHECK_EVERY = 15;
/** How long (from the start of the call) the send step may START new sends: the usual slice, and the longer one while drafting is paused by the backlog gate. */
export const SEND_SLICE_MS = 10_000;
/** Bookkeeping that registers/parks old drafts runs BEFORE sending: it gets a small slice and batch so it can never use the Sheets quota sending needs. */
export const ADOPT_SLICE_MS = 6_000;
export const ADOPT_BATCH = 8;
export const SEND_SLICE_BACKLOG_MS = 16_000;
/** When Google answers 429 this often within one run, drafting (the slowest step) yields for this run; sending and importing already ran. */
export const DRAFT_YIELD_AFTER_RATE_LIMITS = 8;

export interface CycleDeps {
  config: OutreachConfig;
  sheet: Partial<Pick<OutreachSheet, "readPriority">> & Pick<OutreachSheet, "ensureTabs" | "readMaster" | "readTracking" | "appendTracking" | "updateTracking" | "upsertCounters" | "acquireLock" | "releaseLock" | "readSendLedger" | "claimMilestone" | "completeMilestone" | "releaseMilestone" | "claimedMilestones" | "setState">;
  connections: ConnectionsPort;
  ledger(): Promise<ReadonlyMap<string, LedgerEntry>>;
  connected(): Promise<MemberId[]>;
  /** The existing drafting worker (same one the Network Finder cron runs). Absent = skip drafting this call. */
  draft?: (limit: number) => Promise<{ checked: number; created: number; remaining: number; paused?: string } | "busy">;
  /** The send step. Only ever called when `gate` is true; the real wiring does not even construct it while the gate is closed. */
  send?: () => Promise<SendRunResult>;
  /** Notes on a draft-ledger row why its draft cannot be sent (null clears it). Only the note changes; the Gmail draft is never touched. */
  parkDraft?: (draftKey: string, reason: string | null) => Promise<void>;
  /** Tells a member privately when their Gmail authorisation has lapsed or is about to (see gmail-health.ts). Absent = no alerts. */
  gmailHealth?: Pick<GmailHealthDeps, "accounts" | "notifyMember">;
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
  /** Unsent JobSync drafts of Connections that had no tracking row yet (any age), brought into the send workflow. */
  existing?: AdoptResult;
  import?: ImportResult;
  /** `paused`: the draft-backlog gate stopped new drafting (reason; counts only). */
  drafts?: { checked: number; created: number; remaining: number; paused?: string } | "busy" | "skipped";
  send?: SendRunResult;
  announced?: { connections: number; sentBlocks: number };
  /** Members whose Gmail authorisation has lapsed / is about to, and how many private alerts were sent in this call. */
  gmail?: GmailHealthResult;
  counters?: DailyCounters;
  errors: string[];
}

export async function runOutreachCycle(deps: CycleDeps): Promise<CycleResult> {
  if (!deps.config.enabled) return { ran: false, reason: "disabled", errors: [] };
  const t = deps.now().getTime();
  if (!(await deps.sheet.acquireLock(t, OUTREACH_LOCK_TTL_MS))) return { ran: false, reason: "busy", errors: [] };
  const result: CycleResult = { ran: true, errors: [] };
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    const began = Date.now();
    try {
      return await fn();
    } catch (err) {
      result.errors.push(`${name}: ${err instanceof Error ? err.name : "error"}`);
      return undefined;
    } finally {
      // Timing only (no data): shows which step used the call's time when a call is slow or times out.
      const ms = Date.now() - began;
      if (ms >= 2_000) console.log(`[outreach-step] ${name} ${ms}ms`);
    }
  };
  try {
    await deps.sheet.ensureTabs();
    result.manual = await step("manual", () => registerManualConnections({ sheet: deps.sheet, connections: deps.connections, now: deps.now, since: deps.config.manualSince }));
    // EVERY unsent JobSync draft in the members' Gmail, however old, must be looked at by the send step: register the Connections that have none yet.
    result.existing = await step("existing-drafts", () => adoptExistingDrafts({ sheet: deps.sheet, connections: deps.connections, ledger: deps.ledger, now: deps.now, ...(deps.parkDraft ? { park: deps.parkDraft } : {}), deadline: Math.min(deps.deadline ?? Infinity, Date.now() + ADOPT_SLICE_MS), perRun: ADOPT_BATCH }));
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
    if (deps.gmailHealth) {
      const health = deps.gmailHealth;
      result.gmail = await step("gmail-health", () => runGmailHealth({ sheet: deps.sheet, accounts: health.accounts, notifyMember: health.notifyMember, now: deps.now, timezone: deps.timezone }));
    }
    await step("counters", async () => {
      const { records } = await deps.sheet.readTracking();
      const { records: ledger } = await deps.sheet.readSendLedger();
      const parsed = parseMasterRows(await deps.sheet.readMaster());
      const tracked = new Set(records.map((r) => r.contactId));
      const first = firstInDuplicateGroups(parsed.contacts);
      let remaining = [...eligibleIdSet(parsed)].filter((id) => !tracked.has(id)).length;
      // Priority contacts that are not in Master Contacts at all (promoted ones are already counted above).
      if (deps.sheet.readPriority) {
        const inMaster = new Set(parsed.contacts.map((c) => c.contactId));
        remaining += resolvePriorityContacts(await deps.sheet.readPriority(), parsed).contacts.filter((c) => !inMaster.has(c.contactId) && !tracked.has(c.contactId) && importEligibility(c, first).eligible).length;
      }
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
        // The row is only used to carry the other columns over; recordDraft itself re-reads the tab fresh (under the write lock) to find the row.
        const current = (await readDraftLedger()).get(`contact:${connectionId}:${m}`);
        if (current) await recordDraft({ ...current, status: "sent", checkedAt: new Date().toISOString() });
      },
      // Notes WHY an unsent draft cannot be sent (or clears the note). Only the ledger row's note changes; the draft in Gmail is never touched.
      setParked: async (m, connectionId, reason) => {
        const current = (await readDraftLedger({ fresh: true })).get(`contact:${connectionId}:${m}`);
        if (current && current.status === "created") await recordDraft({ ...current, detail: withParkedReason(current.detail, reason) });
      },
    },
    allowlist: config.sendAllowlist,
    reviewRecheckEvery: REVIEW_RECHECK_EVERY,
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
  const backlog = getDraftBacklogGate();
  return {
    config,
    sheet,
    gate,
    notify: async (payload, key) => ((await notifyEveryone(payload, key)).status === "unreadable" ? "retry" : "done"),
    // The send step is only built when the compile-time gate is open. In the shipped state this is undefined.
    ...(gate
      ? {
          send: async () => {
            // Backlog priority: while drafting is paused (100+ unsent drafts in Gmail, or the count is unavailable) there is nothing else to spend the
            // time on, so sending gets a bigger slice of this call. Otherwise it keeps its usual slice and drafting/importing share the rest.
            const open = (await backlog.check().catch(() => ({ allowed: false }))).allowed;
            try {
              return await runSendStep(buildRealSendDeps(config, sheet, timezone, started + (open ? SEND_SLICE_MS : SEND_SLICE_BACKLOG_MS)));
            } finally {
              backlog.invalidate(); // sends just freed drafts: the drafting step must recount, not reuse the count from before
            }
          },
        }
      : {}),
    connections: realConnectionsPort,
    gmailHealth: {
      accounts: async () => (await readGmailAccounts()).map((a) => ({ memberId: a.memberId, status: a.status, connectedAt: a.connectedAt })),
      notifyMember: async (member, payload) => {
        try {
          await notifyMember(member, payload);
          return "done";
        } catch {
          return "retry"; // the subscription list could not be read: try again on a later pass
        }
      },
    },
    parkDraft: async (draftKey, reason) => {
      // recordDraft re-reads the tab fresh under the write lock to find the row; this read only carries the other columns, so a cached one is enough.
      const current = (await readDraftLedger({ allowStaleMs: 20_000 })).get(draftKey);
      if (current && current.status === "created") await recordDraft({ ...current, detail: withParkedReason(current.detail, reason) });
    },
    // Registration of existing drafts and the status sync are bookkeeping: a ledger up to 20 s old is fine (this instance's own writes invalidate it at once).
    ledger: async () => new Map([...(await readDraftLedger({ allowStaleMs: 20_000 })).entries()].map(([k, v]) => [k, { status: v.status, detail: v.detail, gmailDraftId: v.gmailDraftId, ...(v.threadId ? { threadId: v.threadId } : {}) }])),
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
    existing: r.existing ?? null,
    import: r.import ? { ...r.import } : null,
    drafts: r.drafts ?? null,
    send: r.send ? { ...r.send } : null,
    announced: r.announced ?? null,
    gmail: r.gmail ?? null,
    counters: r.counters ?? null,
    errors: r.errors,
  };
}
