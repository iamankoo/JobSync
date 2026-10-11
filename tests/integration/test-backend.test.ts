import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as seed } from "@/app/api/test/seed/route";
import { getSheetsClient, isMemoryBackend, setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { memorySheets } from "@/lib/google-sheets/memory-client";

const req = (body: unknown, key?: string) =>
  new Request("http://localhost/api/test/seed", { method: "POST", headers: { "content-type": "application/json", ...(key ? { "x-test-key": key } : {}) }, body: JSON.stringify(body) });

afterEach(() => {
  vi.unstubAllEnvs();
  setSheetsClientForTesting(null);
  memorySheets().reset();
});

describe("the isolated in-memory test backend can never run in production", () => {
  it("is off by default", () => {
    expect(isMemoryBackend({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("is on only when SHEETS_TEST_BACKEND=memory outside production", () => {
    expect(isMemoryBackend({ SHEETS_TEST_BACKEND: "memory", NODE_ENV: "development" } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(isMemoryBackend({ SHEETS_TEST_BACKEND: "memory", NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(isMemoryBackend({ SHEETS_TEST_BACKEND: "other", NODE_ENV: "development" } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it("the data layer refuses to start if the flag is ever set in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SHEETS_TEST_BACKEND", "memory");
    expect(() => getSheetsClient()).toThrowError(/must never be set in production/);
  });

  it("the seed route answers 404 whenever the memory backend is off, whatever the key", async () => {
    vi.stubEnv("TEST_SEED_KEY", "k");
    vi.stubEnv("SHEETS_TEST_BACKEND", "");
    expect((await seed(req({ action: "reset" }, "k"))).status).toBe(404);
  });

  it("the seed route answers 404 in production even if both variables are set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SHEETS_TEST_BACKEND", "memory");
    vi.stubEnv("TEST_SEED_KEY", "k");
    expect((await seed(req({ action: "reset" }, "k"))).status).toBe(404);
  });

  it("with the backend on, the seed route needs the right key", async () => {
    vi.stubEnv("SHEETS_TEST_BACKEND", "memory");
    vi.stubEnv("TEST_SEED_KEY", "the-key");
    expect((await seed(req({ action: "reset" }))).status).toBe(404);
    expect((await seed(req({ action: "reset" }, "wrong"))).status).toBe(404);
    expect((await seed(req({ action: "reset" }, "the-key"))).status).toBe(200);
  });

  it("supports reset, append, update-by-header and dump on the in-memory copy of the four tabs", async () => {
    vi.stubEnv("SHEETS_TEST_BACKEND", "memory");
    vi.stubEnv("TEST_SEED_KEY", "the-key");
    expect(getSheetsClient()).toBe(memorySheets());
    await seed(req({ action: "reset" }, "the-key"));
    await seed(req({ action: "append", tab: "Applications", rows: [["job_1", "anni", "Applied", "2026-10-01T10:00:00.000Z", "", "", "2026-10-01T10:00:00.000Z", "", ""]] }, "the-key"));
    const upd = await (await seed(req({ action: "update", tab: "Applications", where: { JobID: "job_1", MemberID: "anni" }, set: { AppliedAt: "2026-09-20T10:00:00.000Z" } }, "the-key"))).json();
    expect(upd.changed).toBe(1);
    const dump = await (await seed(req({ action: "dump", tab: "Applications" }, "the-key"))).json();
    expect(dump.rows[0]).toEqual(["JobID", "MemberID", "Status", "AppliedAt", "ApplicationStage", "Notes", "LastUpdated", "FollowUpAnswer", "FollowUpAnsweredAt"]);
    expect(dump.rows[1][3]).toBe("2026-09-20T10:00:00.000Z");
    const members = await (await seed(req({ action: "dump", tab: "Members" }, "the-key"))).json();
    expect(members.rows.slice(1).map((r: string[]) => r[0])).toEqual(["anni", "lukky", "rishii"]);
  });
});
