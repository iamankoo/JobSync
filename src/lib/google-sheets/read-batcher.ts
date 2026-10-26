import "server-only";
import { SheetsError } from "./errors";

/** How long reads wait to be grouped. Long enough to catch a layout and its page rendering together. */
export const BATCH_WINDOW_MS = 8;

/**
 * Groups reads issued at about the same time into ONE `values.batchGet` request. Google counts a
 * batchGet as a single read against the per-minute quota, so a page that needs four tabs costs one
 * read instead of four. Each caller still gets exactly its own range's values, read at flush time
 * (never earlier than it asked), so freshness guarantees are unchanged.
 *
 * If the combined request fails because ONE range is invalid (e.g. an optional tab that does not
 * exist), the ranges are re-read individually so that error reaches only the caller it belongs to.
 */
export function createReadBatcher(
  fetchMany: (ranges: string[]) => Promise<string[][][]>,
  fetchOne: (range: string) => Promise<string[][]>,
  windowMs: number = BATCH_WINDOW_MS,
): (range: string) => Promise<string[][]> {
  type Batch = Map<string, { resolve: (v: string[][]) => void; reject: (e: unknown) => void }[]>;
  let pending: Batch | null = null;

  async function flush(batch: Batch) {
    const ranges = [...batch.keys()];
    const settle = (range: string, outcome: { ok: true; values: string[][] } | { ok: false; error: unknown }) => {
      for (const waiter of batch.get(range)!) {
        // Each caller gets its own copy so one caller mutating rows cannot affect another.
        if (outcome.ok) waiter.resolve(outcome.values.map((row) => [...row]));
        else waiter.reject(outcome.error);
      }
    };
    if (ranges.length === 1) {
      try {
        settle(ranges[0], { ok: true, values: await fetchOne(ranges[0]) });
      } catch (error) {
        settle(ranges[0], { ok: false, error });
      }
      return;
    }
    try {
      const results = await fetchMany(ranges);
      ranges.forEach((range, i) => settle(range, { ok: true, values: results[i] ?? [] }));
    } catch (error) {
      if (error instanceof SheetsError && error.code === "schema_invalid") {
        await Promise.all(
          ranges.map(async (range) => {
            try {
              settle(range, { ok: true, values: await fetchOne(range) });
            } catch (e) {
              settle(range, { ok: false, error: e });
            }
          }),
        );
        return;
      }
      for (const range of ranges) settle(range, { ok: false, error });
    }
  }

  return (range) =>
    new Promise<string[][]>((resolve, reject) => {
      let batch = pending;
      if (!batch) {
        const created: Batch = new Map();
        batch = pending = created;
        setTimeout(() => {
          pending = null;
          void flush(created);
        }, windowMs);
      }
      const waiters = batch.get(range) ?? [];
      waiters.push({ resolve, reject });
      batch.set(range, waiters);
    });
}
