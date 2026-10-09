import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { createJob, listJobsForMember } from "@/lib/google-sheets/jobs-service";
import { listApplicationsForMember, setApplicationStatus } from "@/lib/google-sheets/applications-service";
import { isMemberActive, resetMembersCache } from "@/lib/google-sheets/members-service";
import { checkSheetsStatus } from "@/lib/google-sheets/status-service";
import { readActivity, readApplications, readJobs } from "@/lib/google-sheets/repositories";
import { DomainError, SheetsError } from "@/lib/google-sheets/errors";
import type { CreateJobInput } from "@/lib/validation/jobs";
import { FakeSheets, googleError } from "../helpers/fake-sheets";

let sheets: FakeSheets;

const input = (over: Partial<CreateJobInput> = {}): CreateJobInput => ({
  company: "Synthetic Co A",
  jobRole: "Test Role",
  jobType: "Internship",
  location: "Testville",
  jobUrl: "https://jobs.example.test/jobs/1",
  ...over,
});

const NOW = new Date("2026-10-09T10:00:00.000Z");

beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
});
afterEach(() => setSheetsClientForTesting(null));

describe("jobs: create and list", () => {
  it("creates a job with a stable unique ID, UTC timestamp and the session member as contributor", async () => {
    const a = await createJob("anni", input(), NOW);
    const b = await createJob("lukky", input({ jobUrl: "https://jobs.example.test/jobs/2" }), NOW);
    expect(a.jobId).toMatch(/^job_[0-9a-f-]{36}$/);
    expect(a.jobId).not.toBe(b.jobId);
    expect(a.addedBy).toBe("anni");
    expect(b.addedBy).toBe("lukky");
    expect(a.addedAt).toBe("2026-10-09T10:00:00.000Z");
    const stored = sheets.dataRows("Jobs");
    expect(stored).toHaveLength(2);
    expect(stored[0][0]).toBe(a.jobId);
    expect(stored[0][11]).toBe("anni");
  });

  it("stores values as given and writes them as plain text (no formula interpretation needed)", async () => {
    const j = await createJob("anni", input({ company: "=HYPERLINK(\"http://evil\")", stipendSalary: "+1000" }), NOW);
    expect(j.company).toBe('=HYPERLINK("http://evil")');
    // The client writes with valueInputOption RAW; here we assert the cell is passed through unchanged.
    expect(sheets.dataRows("Jobs")[0][1]).toBe('=HYPERLINK("http://evil")');
  });

  it("rejects duplicate URLs including normalized variants, naming the existing job", async () => {
    const first = await createJob("anni", input(), NOW);
    for (const url of [
      "https://jobs.example.test/jobs/1",
      "http://www.jobs.example.test/jobs/1/",
      "HTTPS://JOBS.EXAMPLE.TEST/jobs/1?utm_source=linkedin#apply",
    ]) {
      await expect(createJob("lukky", input({ jobUrl: url }), NOW)).rejects.toMatchObject({
        code: "duplicate_url",
        details: { existingJobId: first.jobId },
      });
    }
    expect(sheets.dataRows("Jobs")).toHaveLength(1);
  });

  it("allows different URLs", async () => {
    await createJob("anni", input(), NOW);
    await expect(createJob("anni", input({ jobUrl: "https://jobs.example.test/jobs/2" }), NOW)).resolves.toBeDefined();
  });

  it("lets only one of many simultaneous requests for the same URL succeed (single instance)", async () => {
    const results = await Promise.allSettled([
      createJob("anni", input(), NOW),
      createJob("lukky", input({ jobUrl: "https://www.jobs.example.test/jobs/1/" }), NOW),
      createJob("rishii", input({ jobUrl: "https://jobs.example.test/jobs/1?utm_medium=x" }), NOW),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected" && (r.reason as DomainError).code === "duplicate_url")).toHaveLength(2);
    expect(sheets.dataRows("Jobs")).toHaveLength(1);
  });

  it("all members see the same shared jobs, newest first", async () => {
    await createJob("anni", input(), new Date("2026-10-09T09:00:00Z"));
    await createJob("lukky", input({ jobUrl: "https://x.com/2", company: "Synthetic Co B" }), new Date("2026-10-09T11:00:00Z"));
    const [a, l, r] = await Promise.all((["anni", "lukky", "rishii"] as const).map((m) => listJobsForMember(m)));
    for (const res of [a, l, r]) expect(res.jobs.map((j) => j.company)).toEqual(["Synthetic Co B", "Synthetic Co A"]);
  });

  it("writes an activity record for job_added with the session member", async () => {
    const j = await createJob("rishii", input(), NOW);
    const { items } = await readActivity();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ memberId: "rishii", action: "job_added", jobId: j.jobId, timestamp: "2026-10-09T10:00:00.000Z" });
    expect(items[0].activityId).toMatch(/^act_/);
    expect(items[0].date).toBe("2026-10-09");
  });

  it("does not fail the request when only the activity write fails", async () => {
    const original = sheets.appendValues.bind(sheets);
    sheets.appendValues = async (range, rows) => {
      if (range.startsWith("Activity")) throw googleError(500);
      return original(range, rows);
    };
    await expect(createJob("anni", input(), NOW)).resolves.toBeDefined();
    expect(sheets.dataRows("Jobs")).toHaveLength(1);
    expect(sheets.dataRows("Activity")).toHaveLength(0);
  });
});

describe("malformed and hand-edited rows", () => {
  const good = ["job_good", "Synthetic Co A", "Test Role", "Full-time", "", "", "", "Testville", "https://example.test/1", "", "", "anni", "2026-10-01T00:00:00.000Z"];

  it("skips bad rows, keeps good ones, ignores blank rows and duplicate JobIDs, and reports counts", async () => {
    sheets.rows("Jobs").push(
      good,
      ["", "", "", "", "", "", "", "", "", "", "", "", ""],
      ["job_bad1", "", "SWE", "Full-time", "", "", "", "Testville", "https://example.test/2", "", "", "anni", "2026-10-01T00:00:00.000Z"],
      ["job_bad2", "X", "Y", "Full-time", "", "", "", "Testville", "ht!tp://nope", "", "", "anni", "2026-10-01T00:00:00.000Z"],
      ["job_bad3", "X", "Y", "Full-time", "", "", "", "Testville", "https://example.test/3", "", "", "ghost", "2026-10-01T00:00:00.000Z"],
      [...good],
      ["job_short"],
    );
    const { items, issues } = await readJobs();
    expect(items.map((j) => j.jobId)).toEqual(["job_good"]);
    expect(issues.length).toBe(5); // bad1, bad2, bad3, duplicate, short
    const { skippedRows } = await listJobsForMember("anni");
    expect(skippedRows).toBe(5);
  });

  it("a hand-added row is treated like any other once valid", async () => {
    sheets.rows("Jobs").push(good);
    await expect(createJob("lukky", input({ jobUrl: "https://www.example.test/1/" }), NOW)).rejects.toMatchObject({ code: "duplicate_url" });
  });

  it("ignores application rows with unknown members/statuses and keeps the first of duplicate pairs", async () => {
    sheets.rows("Jobs").push(good);
    sheets.rows("Applications").push(
      ["job_good", "anni", "Applied", "2026-10-02T00:00:00.000Z", "", "", "2026-10-02T00:00:00.000Z"],
      ["job_good", "anni", "Rejected", "", "", "", "2026-10-03T00:00:00.000Z"], // duplicate pair: ignored
      ["job_good", "eve", "Applied", "", "", "", "2026-10-02T00:00:00.000Z"], // unknown member
      ["job_good", "lukky", "Hired", "", "", "", "2026-10-02T00:00:00.000Z"], // bad status
    );
    const { items, issues } = await readApplications();
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("Applied");
    expect(issues).toHaveLength(3);
    expect((await listApplicationsForMember("lukky"))).toEqual([]);
  });
});

describe("applications: independent per-member status", () => {
  let jobId: string;
  beforeEach(async () => {
    jobId = (await createJob("anni", input(), NOW)).jobId;
  });

  it("defaults every member to Not Applied", async () => {
    for (const m of ["anni", "lukky", "rishii"] as const) {
      expect((await listJobsForMember(m)).jobs[0].myStatus).toBe("Not Applied");
      expect(await listApplicationsForMember(m)).toEqual([]);
    }
  });

  it("Anni applying does not change Lukky's or Rishii's status", async () => {
    const r = await setApplicationStatus("anni", jobId, { status: "Applied" }, NOW);
    expect(r).toMatchObject({ status: "Applied", changed: true });
    expect(r.application).toMatchObject({ memberId: "anni", appliedAt: "2026-10-09T10:00:00.000Z" });

    expect((await listJobsForMember("anni")).jobs[0].myStatus).toBe("Applied");
    expect((await listJobsForMember("lukky")).jobs[0].myStatus).toBe("Not Applied");
    expect((await listJobsForMember("rishii")).jobs[0].myStatus).toBe("Not Applied");
    expect(await listApplicationsForMember("lukky")).toEqual([]);
    expect(await listApplicationsForMember("rishii")).toEqual([]);
    expect(sheets.dataRows("Applications")).toHaveLength(1);
  });

  it("each member has an independent record that only they can change", async () => {
    await setApplicationStatus("anni", jobId, { status: "Applied" }, NOW);
    await setApplicationStatus("lukky", jobId, { status: "Applied" }, NOW);
    await setApplicationStatus("lukky", jobId, { status: "Interview", applicationStage: "HR Interview", notes: "went well" }, NOW);

    const rows = sheets.dataRows("Applications");
    expect(rows).toHaveLength(2);
    const anni = rows.find((r) => r[1] === "anni")!;
    const lukky = rows.find((r) => r[1] === "lukky")!;
    expect(anni[2]).toBe("Applied");
    expect(anni[4]).toBe("");
    expect(anni[5]).toBe("");
    expect(lukky[2]).toBe("Interview");
    expect(lukky[4]).toBe("HR Interview");
    expect(lukky[5]).toBe("went well");
    expect((await listJobsForMember("rishii")).jobs[0].myStatus).toBe("Not Applied");
    expect((await listJobsForMember("anni")).jobs[0].myStatus).toBe("Applied");
  });

  it("never returns other members' application details", async () => {
    await setApplicationStatus("lukky", jobId, { status: "Applied", notes: "private note" }, NOW);
    const anniApps = await listApplicationsForMember("anni");
    expect(JSON.stringify(anniApps)).not.toContain("private note");
    const anniJobs = await listJobsForMember("anni");
    expect(JSON.stringify(anniJobs)).not.toContain("private note");
    expect(Object.keys(anniJobs.jobs[0])).not.toContain("applications");
  });

  it("updates the same row in place rather than creating duplicates (unique per member+job)", async () => {
    await setApplicationStatus("anni", jobId, { status: "Applied" }, NOW);
    await setApplicationStatus("anni", jobId, { status: "In Progress" }, new Date("2026-10-10T10:00:00Z"));
    await setApplicationStatus("anni", jobId, { status: "Interview" }, new Date("2026-10-11T10:00:00Z"));
    const rows = sheets.dataRows("Applications");
    expect(rows).toHaveLength(1);
    expect(rows[0][2]).toBe("Interview");
    expect(rows[0][3]).toBe("2026-10-09T10:00:00.000Z"); // AppliedAt preserved
    expect(rows[0][6]).toBe("2026-10-11T10:00:00.000Z"); // LastUpdated advanced
  });

  it("targets the correct row when many members/jobs exist", async () => {
    const j2 = (await createJob("anni", input({ jobUrl: "https://x.com/2" }), NOW)).jobId;
    await setApplicationStatus("rishii", jobId, { status: "Applied" }, NOW);
    await setApplicationStatus("anni", j2, { status: "Applied" }, NOW);
    await setApplicationStatus("anni", jobId, { status: "Applied" }, NOW);
    await setApplicationStatus("anni", jobId, { status: "Offer" }, NOW);
    const find = (m: string, j: string) => sheets.dataRows("Applications").find((r) => r[0] === j && r[1] === m)!;
    expect(find("anni", jobId)[2]).toBe("Offer");
    expect(find("anni", j2)[2]).toBe("Applied");
    expect(find("rishii", jobId)[2]).toBe("Applied");
  });

  it("handles simultaneous applies by the same member without creating two rows", async () => {
    await Promise.all([
      setApplicationStatus("anni", jobId, { status: "Applied" }, NOW),
      setApplicationStatus("anni", jobId, { status: "Applied" }, NOW),
      setApplicationStatus("anni", jobId, { status: "Applied" }, NOW),
    ]);
    expect(sheets.dataRows("Applications")).toHaveLength(1);
  });

  it("handles simultaneous applies by different members, giving each exactly one row", async () => {
    await Promise.all((["anni", "lukky", "rishii"] as const).map((m) => setApplicationStatus(m, jobId, { status: "Applied" }, NOW)));
    const rows = sheets.dataRows("Applications");
    expect(rows.map((r) => r[1]).sort()).toEqual(["anni", "lukky", "rishii"]);
  });

  it("rejects unknown jobs without writing", async () => {
    await expect(setApplicationStatus("anni", "job_missing", { status: "Applied" }, NOW)).rejects.toMatchObject({ code: "job_not_found" });
    expect(sheets.dataRows("Applications")).toHaveLength(0);
  });

  it("enforces transitions", async () => {
    await expect(setApplicationStatus("anni", jobId, { status: "Offer" }, NOW)).rejects.toMatchObject({ code: "invalid_transition" });
    await setApplicationStatus("anni", jobId, { status: "Applied" }, NOW);
    await setApplicationStatus("anni", jobId, { status: "Rejected" }, NOW);
    await expect(setApplicationStatus("anni", jobId, { status: "Applied" }, NOW)).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("Not Applied with no record is a no-op; undoing clears AppliedAt and stage", async () => {
    expect(await setApplicationStatus("anni", jobId, { status: "Not Applied" }, NOW)).toMatchObject({ application: null, changed: false });
    expect(sheets.dataRows("Applications")).toHaveLength(0);

    await setApplicationStatus("anni", jobId, { status: "Applied", applicationStage: "Submitted" }, NOW);
    const undone = await setApplicationStatus("anni", jobId, { status: "Not Applied" }, NOW);
    expect(undone.application).toMatchObject({ status: "Not Applied" });
    expect(undone.application?.appliedAt).toBeUndefined();
    expect(undone.application?.applicationStage).toBeUndefined();
    expect(sheets.dataRows("Applications")).toHaveLength(1);
    expect((await listJobsForMember("anni")).jobs[0].myStatus).toBe("Not Applied");
  });

  it("is idempotent: repeating an identical update writes nothing", async () => {
    await setApplicationStatus("anni", jobId, { status: "Applied" }, NOW);
    const before = sheets.calls.filter((c) => c.op !== "get").length;
    const again = await setApplicationStatus("anni", jobId, { status: "Applied" }, new Date("2026-10-20T00:00:00Z"));
    expect(again.changed).toBe(false);
    expect(sheets.calls.filter((c) => c.op !== "get").length).toBe(before);
  });

  it("records job_applied once, then application_updated for later changes", async () => {
    await setApplicationStatus("lukky", jobId, { status: "Applied" }, NOW);
    await setApplicationStatus("lukky", jobId, { status: "Interview" }, NOW);
    const actions = (await readActivity()).items.filter((a) => a.memberId === "lukky").map((a) => a.action);
    expect(actions).toEqual(["job_applied", "application_updated"]);
    expect((await readActivity()).items.filter((a) => a.memberId === "anni").map((a) => a.action)).toEqual(["job_added"]);
  });
});

describe("members tab", () => {
  it("reports active members from the tab and treats missing/FALSE rows as inactive", async () => {
    sheets = new FakeSheets();
    sheets.seedMembers({ rishii: false });
    sheets.rows("Members").splice(1, 1); // remove anni's row
    setSheetsClientForTesting(sheets);
    resetMembersCache();
    expect(await isMemberActive("anni")).toBe(false);
    expect(await isMemberActive("lukky")).toBe(true);
    expect(await isMemberActive("rishii")).toBe(false);
  });

  it("caches reads briefly", async () => {
    await isMemberActive("anni");
    await isMemberActive("lukky");
    expect(sheets.calls.filter((c) => c.range.startsWith("Members"))).toHaveLength(1);
  });
});

describe("schema and upstream failures", () => {
  it("refuses to read or write when headers are wrong, without modifying the sheet", async () => {
    sheets.rows("Jobs")[0][2] = "Role";
    const before = JSON.stringify(sheets.rows("Jobs"));
    await expect(listJobsForMember("anni")).rejects.toMatchObject({ code: "schema_invalid" });
    await expect(createJob("anni", input(), NOW)).rejects.toBeInstanceOf(SheetsError);
    expect(JSON.stringify(sheets.rows("Jobs"))).toBe(before);
  });

  it("reports an empty tab (no header) and a missing tab as schema errors", async () => {
    sheets.tabs.set("Jobs", []);
    await expect(readJobs()).rejects.toMatchObject({ code: "schema_invalid" });
    sheets.tabs.delete("Applications");
    await expect(readApplications()).rejects.toMatchObject({ code: "schema_invalid" });
  });

  it.each([
    [401, "auth_failed"],
    [403, "permission_denied"],
    [404, "spreadsheet_not_found"],
  ])("maps Google %i to %s", async (status, code) => {
    sheets.failAll = googleError(status as number, status === 403 ? "forbidden" : undefined);
    await expect(listJobsForMember("anni")).rejects.toMatchObject({ code });
  });

  it("surfaces quota errors as rate_limited after retries on reads", async () => {
    sheets.failAll = googleError(429);
    await expect(readJobs()).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("does not claim success when the write fails", async () => {
    sheets.failNext = { op: "append", error: googleError(500) };
    await expect(createJob("anni", input(), NOW)).rejects.toBeInstanceOf(SheetsError);
    expect(sheets.dataRows("Jobs")).toHaveLength(0);
    // and the failed attempt does not poison later requests
    await expect(createJob("anni", input(), NOW)).resolves.toBeDefined();
  });

  it("reports a truncated header row as a schema error", async () => {
    sheets.getValues = async () => [["JobID"], ...Array(0)] as string[][];
    await expect(readJobs()).rejects.toMatchObject({ code: "schema_invalid" });
  });
});

describe("checkSheetsStatus", () => {
  const env = {
    GOOGLE_SHEETS_SPREADSHEET_ID: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "svc@proj.iam.gserviceaccount.com",
    GOOGLE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nX\\n-----END PRIVATE KEY-----\\n",
  };
  beforeEach(() => {
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
  });
  afterEach(() => {
    for (const k of Object.keys(env)) delete process.env[k];
  });

  it("reports healthy tabs with row and issue counts, and no secrets", async () => {
    await createJob("anni", input(), NOW);
    const res = await checkSheetsStatus();
    expect(res.ok).toBe(true);
    expect(res.tabs.map((t) => t.tab)).toEqual(["Jobs", "Applications", "Members", "Activity"]);
    expect(res.tabs.find((t) => t.tab === "Jobs")).toMatchObject({ ok: true, rows: 1, rowIssues: 0 });
    const text = JSON.stringify(res);
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toContain(env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
  });

  it("flags a tab with wrong headers and a missing tab without throwing", async () => {
    sheets.rows("Members")[0][3] = "IsActive";
    sheets.tabs.delete("Activity");
    const res = await checkSheetsStatus();
    expect(res.ok).toBe(false);
    expect(res.tabs.find((t) => t.tab === "Members")?.ok).toBe(false);
    expect(res.tabs.find((t) => t.tab === "Activity")?.ok).toBe(false);
    expect(res.tabs.find((t) => t.tab === "Jobs")?.ok).toBe(true);
  });

  it("propagates permission failures", async () => {
    sheets.failAll = googleError(403, "forbidden");
    await expect(checkSheetsStatus()).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("throws not_configured when variables are missing", async () => {
    delete process.env.GOOGLE_PRIVATE_KEY;
    await expect(checkSheetsStatus()).rejects.toMatchObject({ code: "not_configured" });
  });
});
