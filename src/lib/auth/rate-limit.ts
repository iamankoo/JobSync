import "server-only";
import { LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS } from "@/config/auth";

interface Bucket {
  failures: number;
  windowStart: number;
}

/** In-memory limiter. On serverless it is per instance (best effort); see architecture.md. */
const buckets = new Map<string, Bucket>();

function current(key: string, now: number): Bucket | undefined {
  const b = buckets.get(key);
  if (b && now - b.windowStart >= LOGIN_WINDOW_MS) {
    buckets.delete(key);
    return undefined;
  }
  return b;
}

export function checkRateLimit(key: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
  const b = current(key, now);
  if (b && b.failures >= LOGIN_MAX_ATTEMPTS) {
    return { allowed: false, retryAfterSeconds: Math.ceil((b.windowStart + LOGIN_WINDOW_MS - now) / 1000) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

export function recordFailure(key: string, now = Date.now()): void {
  const b = current(key, now);
  if (b) b.failures += 1;
  else buckets.set(key, { failures: 1, windowStart: now });
  if (buckets.size > 1000) {
    for (const [k, v] of buckets) if (now - v.windowStart >= LOGIN_WINDOW_MS) buckets.delete(k);
  }
}

export function resetFailures(key: string): void {
  buckets.delete(key);
}

export function resetAllRateLimits(): void {
  buckets.clear();
}
