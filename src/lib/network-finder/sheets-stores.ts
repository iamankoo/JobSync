import "server-only";
import { MEMBER_IDS, type MemberId } from "@/config/members";
import { getSheetsClient } from "@/lib/google-sheets/client";
import { withWriteLock } from "@/lib/google-sheets/lock";
import { rowRange, tableRange, type TabKey } from "@/lib/google-sheets/schema";
import { invalidateTableCache, readTable } from "@/lib/google-sheets/table";
import type { ApolloUsage, ApolloUsageStore } from "./apollo-pool";
import type { Selection, SelectionStore } from "./distribution";
import { LEASE_MS, MAX_ATTEMPTS, type QueueItem, type QueueState, type QueueStatus, type WorkQueue } from "./queue";
import type { CompanyRecord, CompanyRegistry } from "./registry";
import type { BatchLedger } from "./scheduler";
import type { CompanySourceId, SizeTier, TargetCountry } from "./types";

/**
 * Durable Network Finder bookkeeping in the EXISTING spreadsheet (NF_Companies, NF_Queue, NF_State,
 * NF_Selections). Contacts and jobs are NOT stored here — they live in Connections and Jobs, written only
 * through those services. Each run reads a tab once, then writes through (a run is the only writer: see the
 * run lock in NF_State).
 */
class SheetTable {
  private snapshot: Map<string, { row: number; cells: string[] }> | null = null;
  constructor(private readonly tab: TabKey) {}

  async rows(): Promise<Map<string, { row: number; cells: string[] }>> {
    if (!this.snapshot) {
      const map = new Map<string, { row: number; cells: string[] }>();
      for (const r of await readTable(this.tab, { fresh: true })) {
        const key = r.cells[0]?.trim();
        if (key && !map.has(key)) map.set(key, { row: r.row, cells: r.cells.map((c) => c.trim()) });
      }
      this.snapshot = map;
    }
    return this.snapshot;
  }

  async get(key: string): Promise<string[] | undefined> {
    return (await this.rows()).get(key)?.cells;
  }

  async upsert(key: string, cells: string[]): Promise<void> {
    const rows = await this.rows();
    const existing = rows.get(key);
    await withWriteLock(async () => {
      try {
        if (existing) await getSheetsClient().updateValues(rowRange(this.tab, existing.row), [cells]);
        else await getSheetsClient().appendValues(tableRange(this.tab), [cells]);
      } finally {
        invalidateTableCache();
      }
    });
    if (existing) rows.set(key, { row: existing.row, cells });
    else this.snapshot = null; // the new row number is learned on the next read
  }
}

const num = (s: string | undefined, d = 0) => (s && Number.isFinite(Number(s)) ? Number(s) : d);
const parseJson = <T>(s: string | undefined): T | undefined => {
  try {
    return s ? (JSON.parse(s) as T) : undefined;
  } catch {
    return undefined;
  }
};

class StateTable {
  private t = new SheetTable("nfState");
  async get(key: string) {
    return (await this.t.get(key))?.[1];
  }
  async set(key: string, value: string) {
    await this.t.upsert(key, [key, value, new Date().toISOString()]);
  }
}

class SheetsLedger implements BatchLedger {
  constructor(private s: StateTable) {}
  async get(key: string) {
    return num(await this.s.get(`ledger:${key}`));
  }
  async add(key: string, n: number) {
    const v = (await this.get(key)) + n;
    if (n !== 0) await this.s.set(`ledger:${key}`, String(v));
    return v;
  }
  async getNote(key: string) {
    return (await this.s.get(`note:${key}`)) || undefined;
  }
  async setNote(key: string, value: string) {
    await this.s.set(`note:${key}`, value);
  }
}

class SheetsApolloUsage implements ApolloUsageStore {
  constructor(private s: StateTable) {}
  async get(id: string) {
    return parseJson<ApolloUsage>(await this.s.get(`apollo:${id}`));
  }
  async put(id: string, usage: ApolloUsage) {
    await this.s.set(`apollo:${id}`, JSON.stringify(usage));
  }
}

const REG_STATUSES = ["queued", "processed", "no_contacts", "failed"] as const;

class SheetsRegistry implements CompanyRegistry {
  private t = new SheetTable("nfCompanies");
  constructor(private s: StateTable) {}

  private parse(c: string[]): CompanyRecord | undefined {
    const [key, name, domain, website, source, sourceId, sourceUrl, country, sizeTier, employeeCount, remote, reasons, status, firstSeenAt, lastProcessedAt, lastJobCheckAt, contactsSaved, jobsSaved, careersUrl] = c;
    if (!key || !(REG_STATUSES as readonly string[]).includes(status)) return undefined;
    return {
      key, name, ...(domain ? { domain } : {}), ...(website ? { website } : {}), source: source as CompanySourceId, sourceId, ...(sourceUrl ? { sourceUrl } : {}),
      country: country as TargetCountry, sizeTier: num(sizeTier, 250) as SizeTier, ...(employeeCount ? { employeeCount: num(employeeCount) } : {}),
      ...(remote ? { remoteFriendly: remote === "true" } : {}), reasons: reasons ? reasons.split(" | ") : [], status: status as CompanyRecord["status"],
      firstSeenAt, ...(lastProcessedAt ? { lastProcessedAt } : {}), ...(lastJobCheckAt ? { lastJobCheckAt } : {}), contactsSaved: num(contactsSaved), jobsSaved: num(jobsSaved),
      ...(careersUrl ? { careersUrl } : {}),
    };
  }

  async get(key: string) {
    const c = await this.t.get(key);
    return c ? this.parse(c) : undefined;
  }
  async put(r: CompanyRecord) {
    const careers = r.careersUrl ?? "";
    await this.t.upsert(r.key, [
      r.key, r.name, r.domain ?? "", r.website ?? "", r.source, r.sourceId, r.sourceUrl ?? "", r.country, String(r.sizeTier), r.employeeCount === undefined ? "" : String(r.employeeCount),
      r.remoteFriendly === undefined ? "" : String(r.remoteFriendly), r.reasons.join(" | "), r.status, r.firstSeenAt, r.lastProcessedAt ?? "", r.lastJobCheckAt ?? "",
      String(r.contactsSaved), String(r.jobsSaved), careers,
    ]);
  }
  async all() {
    return [...(await this.t.rows()).values()].map((r) => this.parse(r.cells)).filter((r): r is CompanyRecord => Boolean(r));
  }
  async getCursor(source: CompanySourceId) {
    return (await this.s.get(`cursor:${source}`)) || undefined;
  }
  async setCursor(source: CompanySourceId, cursor: string | undefined) {
    await this.s.set(`cursor:${source}`, cursor ?? "");
  }
}

const Q_STATUSES: readonly QueueStatus[] = ["pending", "running", "done", "failed"];

class SheetsQueue<T> implements WorkQueue<T> {
  private t = new SheetTable("nfQueue");
  constructor(private s: StateTable, private readonly maxAttempts = MAX_ATTEMPTS) {}

  private parse(c: string[]): QueueItem<T> | undefined {
    const [id, status, attempts, notBefore, lastError, payload] = c;
    const p = parseJson<T>(payload);
    if (!id || !(Q_STATUSES as readonly string[]).includes(status) || p === undefined) return undefined;
    return { id, status: status as QueueStatus, attempts: num(attempts), notBefore: num(notBefore), ...(lastError ? { lastError } : {}), payload: p };
  }
  private async write(i: QueueItem<T>) {
    await this.t.upsert(i.id, [i.id, i.status, String(i.attempts), String(i.notBefore), i.lastError ?? "", JSON.stringify(i.payload), new Date().toISOString()]);
  }
  private async pauseState(now: number) {
    const p = parseJson<{ until: number; reason: string }>(await this.s.get("queue:paused"));
    return p && p.until > now ? p : undefined;
  }

  async enqueue(id: string, payload: T, now: number) {
    if (await this.t.get(id)) return false;
    await this.write({ id, payload, status: "pending", attempts: 0, notBefore: now });
    return true;
  }
  async claim(now: number) {
    if (await this.pauseState(now)) return null;
    for (const r of (await this.t.rows()).values()) {
      const item = this.parse(r.cells);
      if (!item || item.notBefore > now || (item.status !== "pending" && item.status !== "running")) continue;
      // A "running" item whose lease expired was abandoned by a crashed run.
      const claimed = { ...item, status: "running" as const, notBefore: now + LEASE_MS };
      await this.write(claimed);
      return claimed;
    }
    return null;
  }
  async complete(id: string) {
    const c = await this.t.get(id);
    const item = c && this.parse(c);
    if (item) await this.write({ ...item, status: "done", lastError: undefined });
  }
  async retry(id: string, now: number, delayMs: number, error: string, options: { countAttempt?: boolean } = {}) {
    const c = await this.t.get(id);
    const item = c && this.parse(c);
    if (!item) return "failed" as const;
    const attempts = item.attempts + (options.countAttempt === false ? 0 : 1);
    const status: QueueStatus = attempts >= this.maxAttempts ? "failed" : "pending";
    await this.write({ ...item, attempts, status, notBefore: now + delayMs, lastError: error.slice(0, 200) });
    return status;
  }
  async pause(until: number, reason: string) {
    const cur = await this.pauseState(0);
    await this.s.set("queue:paused", JSON.stringify({ until: Math.max(cur?.until ?? 0, until), reason }));
  }
  async resume() {
    await this.s.set("queue:paused", "");
  }
  async state(now: number): Promise<QueueState> {
    const p = await this.pauseState(now);
    const pending = [...(await this.t.rows()).values()].filter((r) => r.cells[1] === "pending" || r.cells[1] === "running").length;
    return { paused: Boolean(p), ...(p ? { pausedUntil: p.until, reason: p.reason } : {}), pending };
  }
  async get(id: string) {
    const c = await this.t.get(id);
    return c ? this.parse(c) : undefined;
  }
}

class SheetsSelections implements SelectionStore {
  private t = new SheetTable("nfSelections");
  private parse(c: string[]): Selection | undefined {
    const [companyKey, date, connectionId, assignedTo, contactName, email, emailStatus, createdAt, draftedFor] = c;
    if (!companyKey || !(MEMBER_IDS as readonly string[]).includes(assignedTo)) return undefined;
    return {
      companyKey, date, connectionId, assignedTo: assignedTo as MemberId, contactName, ...(email ? { email } : {}), emailStatus, createdAt,
      draftedFor: (draftedFor ?? "").split(",").map((m) => m.trim()).filter((m): m is MemberId => (MEMBER_IDS as readonly string[]).includes(m)),
    };
  }
  async get(key: string) {
    const c = await this.t.get(key);
    return c ? this.parse(c) : undefined;
  }
  async all() {
    return [...(await this.t.rows()).values()].map((r) => this.parse(r.cells)).filter((s): s is Selection => Boolean(s));
  }
  async forDay(date: string) {
    return (await this.all()).filter((s) => s.date === date);
  }
  async put(s: Selection) {
    await this.t.upsert(s.companyKey, [s.companyKey, s.date, s.connectionId, s.assignedTo, s.contactName, s.email ?? "", s.emailStatus, s.createdAt, s.draftedFor.join(",")]);
  }
}

export interface SheetsStores {
  registry: CompanyRegistry;
  queue: WorkQueue<{ company: import("./types").QualifiedCompany }>;
  ledger: BatchLedger;
  apolloUsage: ApolloUsageStore;
  selections: SelectionStore;
  /** One scheduled run at a time: true if this run got the lock (it expires by itself after `ttlMs`). */
  acquireRunLock(now: number, ttlMs: number): Promise<boolean>;
  releaseRunLock(): Promise<void>;
}

export function createSheetsStores(): SheetsStores {
  const state = new StateTable();
  return {
    registry: new SheetsRegistry(state),
    queue: new SheetsQueue(state),
    ledger: new SheetsLedger(state),
    apolloUsage: new SheetsApolloUsage(state),
    selections: new SheetsSelections(),
    async acquireRunLock(now, ttlMs) {
      const until = num(await state.get("run-lock"));
      if (until > now) return false;
      await state.set("run-lock", String(now + ttlMs));
      return true;
    },
    async releaseRunLock() {
      await state.set("run-lock", "0");
    },
  };
}
