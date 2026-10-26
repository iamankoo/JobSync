import { describe, expect, it, vi } from "vitest";
import { createReadBatcher } from "@/lib/google-sheets/read-batcher";
import { backoffMs } from "@/lib/google-sheets/client";
import { SheetsError } from "@/lib/google-sheets/errors";

const grid = (range: string) => [[`${range}-header`], [`${range}-row`]];

describe("createReadBatcher", () => {
  it("groups simultaneous reads into one request and de-duplicates identical ranges", async () => {
    const many = vi.fn(async (ranges: string[]) => ranges.map(grid));
    const one = vi.fn(async (range: string) => grid(range));
    const read = createReadBatcher(many, one, 1);
    const [a, b, a2] = await Promise.all([read("A!A:B"), read("B!A:B"), read("A!A:B")]);
    expect(many).toHaveBeenCalledTimes(1);
    expect(many).toHaveBeenCalledWith(["A!A:B", "B!A:B"]);
    expect(one).not.toHaveBeenCalled();
    expect(a).toEqual(grid("A!A:B"));
    expect(b).toEqual(grid("B!A:B"));
    expect(a2).toEqual(a);
    a[0][0] = "mutated";
    expect(a2[0][0]).toBe("A!A:B-header"); // callers get independent copies
  });

  it("uses a single get when only one range is requested", async () => {
    const many = vi.fn();
    const one = vi.fn(async (range: string) => grid(range));
    await createReadBatcher(many, one, 1)("A!A:B");
    expect(many).not.toHaveBeenCalled();
    expect(one).toHaveBeenCalledTimes(1);
  });

  it("starts a new batch for reads issued after the window", async () => {
    const many = vi.fn(async (ranges: string[]) => ranges.map(grid));
    const one = vi.fn(async (range: string) => grid(range));
    const read = createReadBatcher(many, one, 1);
    await read("A!A:B");
    await read("B!A:B");
    expect(one).toHaveBeenCalledTimes(2);
  });

  it("isolates an invalid range: only its caller fails", async () => {
    const many = vi.fn(async () => {
      throw new SheetsError("schema_invalid", "missing tab");
    });
    const one = vi.fn(async (range: string) => {
      if (range.startsWith("Missing")) throw new SheetsError("schema_invalid", "missing tab");
      return grid(range);
    });
    const read = createReadBatcher(many, one, 1);
    const [ok, bad] = await Promise.allSettled([read("A!A:B"), read("Missing!A:B")]);
    expect(ok).toEqual({ status: "fulfilled", value: grid("A!A:B") });
    expect(bad).toMatchObject({ status: "rejected", reason: { code: "schema_invalid" } });
  });

  it("propagates other failures to every caller of the batch", async () => {
    const err = new SheetsError("rate_limited", "busy");
    const read = createReadBatcher(async () => Promise.reject(err), async () => grid("x"), 1);
    const results = await Promise.allSettled([read("A!A:B"), read("B!A:B")]);
    expect(results.every((r) => r.status === "rejected" && r.reason === err)).toBe(true);
  });
});

describe("backoffMs", () => {
  const busy = new SheetsError("rate_limited", "busy");
  const blip = new SheetsError("upstream_error", "blip");

  it("waits seconds for quota errors, growing exponentially and capped", () => {
    expect([0, 1, 2, 3, 4, 6].map((n) => backoffMs(busy, n, () => 0.5))).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });

  it("waits less for other transient errors", () => {
    expect([0, 1].map((n) => backoffMs(blip, n, () => 0.5))).toEqual([500, 1000]);
  });

  it("adds ±25 % jitter so instances do not retry in lock-step", () => {
    expect(backoffMs(busy, 0, () => 0)).toBe(750);
    expect(backoffMs(busy, 0, () => 0.999999)).toBe(1250);
  });

  it("honours a Retry-After header (capped)", () => {
    const withHeader = (s: string) => new SheetsError("rate_limited", "busy", { cause: { response: { status: 429, headers: { "retry-after": s } } } });
    expect(backoffMs(withHeader("5"), 0, () => 0.5)).toBe(5000);
    expect(backoffMs(withHeader("600"), 0, () => 0.5)).toBe(10000);
  });
});
