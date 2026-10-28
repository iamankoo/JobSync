/**
 * Work queue for per-company tasks. Every item has an idempotency key (e.g. "company:domain:acme.com"), so
 * enqueuing the same company twice is a no-op. The queue can be paused (e.g. all Apollo accounts exhausted)
 * and resumes by itself at `pausedUntil`. A claimed item holds a lease; if the run dies, the lease expires
 * and the item becomes available again. Retries are safe because saving is deduplicated downstream.
 *
 * This file defines the contract and an in-memory implementation for local runs and tests. The production
 * store (a Sheets tab) will implement the same interface in a later milestone.
 */
export type QueueStatus = "pending" | "running" | "done" | "failed";

export interface QueueItem<T> {
  id: string;
  payload: T;
  status: QueueStatus;
  attempts: number;
  /** Not claimable before this time (backoff / lease expiry). */
  notBefore: number;
  lastError?: string;
}

export interface QueueState {
  paused: boolean;
  pausedUntil?: number;
  reason?: string;
  pending: number;
}

export interface WorkQueue<T> {
  /** Adds an item; false if an item with this id already exists (in any status). */
  enqueue(id: string, payload: T, now: number): Promise<boolean>;
  /** Claims the next due item (null when paused or nothing is due). */
  claim(now: number): Promise<QueueItem<T> | null>;
  complete(id: string): Promise<void>;
  /** Back to pending after `delayMs`. `countAttempt: false` for waits that are not the item's fault. */
  retry(id: string, now: number, delayMs: number, error: string, options?: { countAttempt?: boolean }): Promise<QueueStatus>;
  pause(until: number, reason: string): Promise<void>;
  resume(): Promise<void>;
  state(now: number): Promise<QueueState>;
  get(id: string): Promise<QueueItem<T> | undefined>;
}

export const MAX_ATTEMPTS = 5;
/** A run is killed at 60 s, so a claimed item whose run died is re-offered shortly after, well before the next 5-minute call. */
export const LEASE_MS = 90_000;

export class InMemoryQueue<T> implements WorkQueue<T> {
  private items = new Map<string, QueueItem<T>>();
  private pausedUntil?: number;
  private reason?: string;

  constructor(private readonly maxAttempts: number = MAX_ATTEMPTS) {}

  async enqueue(id: string, payload: T, now: number) {
    if (this.items.has(id)) return false;
    this.items.set(id, { id, payload, status: "pending", attempts: 0, notBefore: now });
    return true;
  }

  private autoResume(now: number) {
    if (this.pausedUntil !== undefined && now >= this.pausedUntil) {
      this.pausedUntil = undefined;
      this.reason = undefined;
    }
  }

  async claim(now: number) {
    this.autoResume(now);
    if (this.pausedUntil !== undefined) return null;
    for (const item of this.items.values()) {
      const due = item.notBefore <= now;
      // A "running" item whose lease expired was abandoned by a crashed run.
      if ((item.status === "pending" && due) || (item.status === "running" && due)) {
        item.status = "running";
        item.notBefore = now + LEASE_MS;
        return { ...item };
      }
    }
    return null;
  }

  async complete(id: string) {
    const item = this.items.get(id);
    if (item) {
      item.status = "done";
      item.lastError = undefined;
    }
  }

  async retry(id: string, now: number, delayMs: number, error: string, options: { countAttempt?: boolean } = {}) {
    const item = this.items.get(id);
    if (!item) return "failed" as const;
    if (options.countAttempt !== false) item.attempts += 1;
    item.lastError = error;
    if (item.attempts >= this.maxAttempts) {
      item.status = "failed";
      return item.status;
    }
    item.status = "pending";
    item.notBefore = now + delayMs;
    return item.status;
  }

  async pause(until: number, reason: string) {
    this.pausedUntil = Math.max(this.pausedUntil ?? 0, until);
    this.reason = reason;
  }

  async resume() {
    this.pausedUntil = undefined;
    this.reason = undefined;
  }

  async state(now: number): Promise<QueueState> {
    this.autoResume(now);
    const pending = [...this.items.values()].filter((i) => i.status === "pending" || i.status === "running").length;
    return { paused: this.pausedUntil !== undefined, ...(this.pausedUntil !== undefined ? { pausedUntil: this.pausedUntil, reason: this.reason } : {}), pending };
  }

  async get(id: string) {
    const item = this.items.get(id);
    return item ? { ...item } : undefined;
  }
}

/** Exponential backoff with a cap: 1 min, 2, 4, 8 … up to 1 h. */
export function backoffDelay(attempts: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}
