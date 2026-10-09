import "server-only";

const g = globalThis as unknown as { __jobsyncWriteLock?: Promise<unknown> };

/**
 * Serialises read-check-write sequences within ONE server instance, so two simultaneous
 * requests cannot both pass a duplicate check. It does NOT coordinate separate serverless
 * instances or people editing the sheet by hand; see architecture.md ("Concurrency").
 */
export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = g.__jobsyncWriteLock ?? Promise.resolve();
  const run = previous.then(fn, fn);
  g.__jobsyncWriteLock = run.catch(() => undefined);
  return run;
}
