import { ApolloPoolExhausted, ProviderError } from "./errors";
import type { ApolloCallContext } from "./providers/types";

/**
 * Pool of Apollo accounts (up to 10), configured ONLY through environment variables:
 *
 *   APOLLO_API_KEY_1 … APOLLO_API_KEY_10   one key per account (unset slots are skipped)
 *   APOLLO_DAILY_LIMIT                     credits/calls per account per day (required: unset = 0 = unusable)
 *   APOLLO_DAILY_LIMIT_<n>                 optional per-account override
 *   APOLLO_PER_MINUTE_LIMIT                calls per account per minute (default 5)
 *
 * Keys never leave this module except as the per-call context handed to the Apollo adapter; status and
 * logs only ever show the account label ("apollo-3"). The daily limit is a ceiling we never cross: usage is
 * counted BEFORE each call, so a failed call still counts (conservative).
 */
export interface ApolloAccount {
  id: string;
  apiKey: string;
  dailyLimit: number;
  perMinuteLimit: number;
}

export const MAX_APOLLO_ACCOUNTS = 10;
const DEFAULT_PER_MINUTE = 5;

const nonNegInt = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isInteger(n) && n >= 0 ? n : fallback;
};

export function loadApolloAccounts(env: NodeJS.ProcessEnv = process.env): ApolloAccount[] {
  const accounts: ApolloAccount[] = [];
  for (let i = 1; i <= MAX_APOLLO_ACCOUNTS; i++) {
    const apiKey = env[`APOLLO_API_KEY_${i}`]?.trim();
    if (!apiKey) continue;
    accounts.push({
      id: `apollo-${i}`,
      apiKey,
      dailyLimit: nonNegInt(env[`APOLLO_DAILY_LIMIT_${i}`], nonNegInt(env.APOLLO_DAILY_LIMIT, 0)),
      perMinuteLimit: nonNegInt(env.APOLLO_PER_MINUTE_LIMIT, DEFAULT_PER_MINUTE),
    });
  }
  return accounts;
}

/**
 * Accounts the scheduled pipeline may use: only those listed in APOLLO_ENABLED_ACCOUNTS (e.g. "1,2"), default
 * account 1 alone — a key being present in the environment does not by itself put an account to use.
 */
export function enabledApolloAccounts(env: NodeJS.ProcessEnv = process.env): ApolloAccount[] {
  const allowed = new Set((env.APOLLO_ENABLED_ACCOUNTS?.trim() || "1").split(",").map((s) => `apollo-${s.trim()}`));
  return loadApolloAccounts(env).filter((a) => allowed.has(a.id) && a.dailyLimit > 0);
}

/** Durable per-account usage (the production store will be a Sheets tab; tests use memory). */
export interface ApolloUsage {
  /** UTC date the `used` count belongs to. */
  day: string;
  used: number;
  /** The account is not used before this time (rate limited, out of credits, or rejected). */
  pausedUntil?: number;
  pauseReason?: string;
}

export interface ApolloUsageStore {
  get(accountId: string): Promise<ApolloUsage | undefined>;
  put(accountId: string, usage: ApolloUsage): Promise<void>;
}

export class InMemoryApolloUsageStore implements ApolloUsageStore {
  private map = new Map<string, ApolloUsage>();
  async get(id: string) {
    const u = this.map.get(id);
    return u ? { ...u } : undefined;
  }
  async put(id: string, usage: ApolloUsage) {
    this.map.set(id, { ...usage });
  }
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const nextUtcMidnight = (ms: number) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};
const MINUTE = 60_000;
const AUTH_PAUSE_MS = 24 * 3_600_000;
/** Out of credits with no reset time given: check again in an hour (a probe call costs nothing if refused). */
const QUOTA_PAUSE_MS = 3_600_000;

export interface AccountStatus {
  id: string;
  used: number;
  dailyLimit: number;
  pausedUntil?: number;
  pauseReason?: string;
}

export class ApolloPool {
  /** Calls made per account in the current minute window (per server instance). */
  private recent = new Map<string, number[]>();

  constructor(
    private readonly accounts: readonly ApolloAccount[],
    private readonly store: ApolloUsageStore,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.accounts.length;
  }

  private async usage(a: ApolloAccount, at: number): Promise<ApolloUsage> {
    const u = await this.store.get(a.id);
    // A new UTC day starts a fresh count; an explicit pause still applies until it ends.
    if (!u || u.day !== utcDay(at)) return { day: utcDay(at), used: 0, ...(u?.pausedUntil && u.pausedUntil > at ? { pausedUntil: u.pausedUntil, pauseReason: u.pauseReason } : {}) };
    return u;
  }

  private minuteCalls(id: string, at: number): number[] {
    const kept = (this.recent.get(id) ?? []).filter((t) => at - t < MINUTE);
    this.recent.set(id, kept);
    return kept;
  }

  /** When this account can next be used (0 = now). */
  private async availableAt(a: ApolloAccount, cost: number, at: number): Promise<number> {
    const u = await this.usage(a, at);
    if (u.pausedUntil && u.pausedUntil > at) return u.pausedUntil;
    if (u.used + cost > a.dailyLimit) return nextUtcMidnight(at);
    const calls = this.minuteCalls(a.id, at);
    if (a.perMinuteLimit > 0 && calls.length >= a.perMinuteLimit) return calls[0] + MINUTE;
    if (a.perMinuteLimit === 0) return nextUtcMidnight(at);
    return 0;
  }

  private async pause(a: ApolloAccount, until: number, reason: string, at: number) {
    const u = await this.usage(a, at);
    await this.store.put(a.id, { ...u, pausedUntil: until, pauseReason: reason });
  }

  /**
   * Runs `fn` on the FIRST account (in order 1, 2, 3 …) that has quota left: account 1 is used until its
   * daily/minute limit or credits run out, then account 2, and so on. If the provider reports a rate limit,
   * exhausted credits or a rejected key, that account is paused and the next one is tried.
   * Throws ApolloPoolExhausted (with the earliest time any account frees up) when none is usable.
   */
  async call<T>(cost: number, fn: (ctx: ApolloCallContext, accountId: string) => Promise<T>): Promise<T> {
    const tried = new Set<string>();
    for (;;) {
      const at = this.now();
      let best: { a: ApolloAccount } | null = null;
      let earliest = Number.POSITIVE_INFINITY;
      for (const a of this.accounts) {
        if (tried.has(a.id)) continue;
        const when = await this.availableAt(a, cost, at);
        if (when > 0) {
          earliest = Math.min(earliest, when);
          continue;
        }
        best = { a };
        break;
      }
      if (!best) {
        // Accounts tried in this call (just paused) also come back at their pause time.
        for (const a of this.accounts) if (tried.has(a.id)) earliest = Math.min(earliest, (await this.availableAt(a, cost, at)) || at + MINUTE);
        throw new ApolloPoolExhausted(Number.isFinite(earliest) ? earliest : nextUtcMidnight(at));
      }
      const { a } = best;
      tried.add(a.id);
      // Count first: the limit is never exceeded, even if the call fails part-way.
      const u = await this.usage(a, at);
      await this.store.put(a.id, { ...u, used: u.used + cost });
      this.minuteCalls(a.id, at).push(at);
      try {
        return await fn({ apiKey: a.apiKey }, a.id);
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        // Apollo's windows start at the first request (not clock-aligned): its retry-after is the best signal.
        if (err.kind === "rate_limited") await this.pause(a, err.retryAt ?? at + MINUTE, "rate_limited", at);
        else if (err.kind === "quota_exhausted") await this.pause(a, err.retryAt ?? at + QUOTA_PAUSE_MS, "quota_exhausted", at);
        else if (err.kind === "auth_failed") await this.pause(a, at + AUTH_PAUSE_MS, "auth_failed", at);
        else throw err; // not an account problem: let the caller decide
      }
    }
  }

  /** Per-account usage for monitoring. Never includes keys. */
  async status(): Promise<AccountStatus[]> {
    const at = this.now();
    return Promise.all(
      this.accounts.map(async (a) => {
        const u = await this.usage(a, at);
        return { id: a.id, used: u.used, dailyLimit: a.dailyLimit, ...(u.pausedUntil && u.pausedUntil > at ? { pausedUntil: u.pausedUntil, pauseReason: u.pauseReason } : {}) };
      }),
    );
  }
}
