import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { createJob, listJobsForMember } from "@/lib/google-sheets/jobs-service";
import { readJobs } from "@/lib/google-sheets/repositories";
import { setTableCacheTtlForTesting } from "@/lib/google-sheets/table";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { FakeSheets, googleError } from "../helpers/fake-sheets";

let sheets: FakeSheets;
const reads = (tab: string) => sheets.calls.filter((c) => c.op === "get" && c.range.startsWith(tab)).length;

beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
  setTableCacheTtlForTesting(5000);
});
afterEach(() => {
  setTableCacheTtlForTesting(null);
  setSheetsClientForTesting(null);
  vi.restoreAllMocks();
});

describe("short-lived read cache (keeps polling within Google's quota)", () => {
  it("shares reads of the same tab within the TTL", async () => {
    await readJobs();
    await readJobs();
    await listJobsForMember("anni");
    await listJobsForMember("lukky");
    expect(reads("Jobs")).toBe(1);
    expect(reads("Applications")).toBe(1);
  });

  it("expires after the TTL", async () => {
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now);
    await readJobs();
    spy.mockReturnValue(now + 4999);
    await readJobs();
    expect(reads("Jobs")).toBe(1);
    spy.mockReturnValue(now + 5001);
    await readJobs();
    expect(reads("Jobs")).toBe(2);
  });

  it("is invalidated by a write on this instance, so people see their own changes immediately", async () => {
    expect((await listJobsForMember("anni")).jobs).toHaveLength(0);
    await createJob("anni", { company: "Synthetic Co", jobRole: "Test Role", jobType: "Internship", location: "Testville", jobUrl: "https://jobs.example.test/1" });
    expect((await listJobsForMember("anni")).jobs).toHaveLength(1);
  });

  it("is bypassed by fresh reads used inside read-check-write sequences", async () => {
    await readJobs();
    await readJobs({ fresh: true });
    expect(reads("Jobs")).toBe(2);
  });

  it("duplicate detection never trusts a stale cache (another instance may have added the link)", async () => {
    await readJobs(); // warm the cache with an empty tab
    // simulate another server instance appending the same job directly in the sheet
    sheets.rows("Jobs").push(["job_other", "Synthetic Co", "Test Role", "Internship", "", "", "", "Testville", "https://jobs.example.test/1", "", "", "lukky", "2026-10-09T10:00:00.000Z"]);
    await expect(
      createJob("anni", { company: "Synthetic Co", jobRole: "Test Role", jobType: "Internship", location: "Testville", jobUrl: "https://jobs.example.test/1" }),
    ).rejects.toMatchObject({ code: "duplicate_url" });
  });

  it("does not cache failures", async () => {
    sheets.failNext = { op: "get", error: googleError(500) };
    await expect(readJobs()).rejects.toBeDefined();
    sheets.failNext = null;
    await expect(readJobs()).resolves.toBeDefined();
    expect(reads("Jobs")).toBeGreaterThanOrEqual(2);
  });

  it("simultaneous reads of a tab share one in-flight request", async () => {
    await Promise.all(Array.from({ length: 8 }, () => readJobs()));
    expect(reads("Jobs")).toBe(1);
  });

  it("a fresh read never joins an in-flight read (read-check-write stays safe)", async () => {
    await Promise.all([readJobs(), readJobs({ fresh: true })]);
    expect(reads("Jobs")).toBe(2);
  });

  it("a read started before a local write is never reused or cached after it", async () => {
    const stale = readJobs(); // in flight, sees the empty tab
    await createJob("anni", { company: "Synthetic Co", jobRole: "Test Role", jobType: "Internship", location: "Testville", jobUrl: "https://jobs.example.test/1" });
    await stale;
    expect((await readJobs()).items).toHaveLength(1);
  });

  it("is disabled when the TTL is 0", async () => {
    setTableCacheTtlForTesting(0);
    await readJobs();
    await readJobs();
    expect(reads("Jobs")).toBe(2);
  });
});
