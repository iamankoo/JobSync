import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { createJob, deleteJob, listJobsForMember, updateJob } from "@/lib/google-sheets/jobs-service";
import { listApplicationsForMember, listMyApplications, setApplicationStatus } from "@/lib/google-sheets/applications-service";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { readActivity } from "@/lib/google-sheets/repositories";
import { getDashboardData } from "@/lib/google-sheets/insights-service";
import type { CreateJobInput } from "@/lib/validation/jobs";
import { FakeSheets, googleError } from "../helpers/fake-sheets";

let sheets: FakeSheets;
const T0 = new Date("2026-10-09T10:00:00.000Z");

const input = (n: number, over: Partial<CreateJobInput> = {}): CreateJobInput => ({
  company: `Synthetic Co ${n}`, jobRole: `Test Role ${n}`, jobType: "Internship", location: "Testville", experience: "0–1 years",
  stipendSalary: "Test pay", workMode: "Remote", deadline: "2026-11-01", description: "Synthetic description",
  jobUrl: `https://jobs.example.test/${n}`, ...over,
});

beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
});
afterEach(() => setSheetsClientForTesting(null));

describe("updateJob", () => {
  it("lets the member who added the job edit it; JobID, AddedBy and AddedAt never change; the row is updated in place", async () => {
    const a = await createJob("anni", input(1), T0);
    const b = await createJob("anni", input(2), T0);
    const before = sheets.rows("Jobs").map((r) => [...r]);

    const edited = await updateJob("anni", a.jobId, input(1, { company: "Corrected Co", jobRole: "Corrected Role", location: "Newtown" }), new Date("2026-10-10T00:00:00Z"));
    expect(edited).toMatchObject({ jobId: a.jobId, addedBy: "anni", addedAt: a.addedAt, company: "Corrected Co", jobRole: "Corrected Role", location: "Newtown" });

    const after = sheets.rows("Jobs");
    expect(after).toHaveLength(before.length);
    expect(after[1][0]).toBe(a.jobId); // same row
    expect(after[1][1]).toBe("Corrected Co");
    expect(after[1][11]).toBe("anni");
    expect(after[1][12]).toBe(a.addedAt);
    expect(after[2]).toEqual(before[2]); // the other job's row is untouched
    expect((await listJobsForMember("lukky")).jobs.find((j) => j.jobId === b.jobId)?.company).toBe("Synthetic Co 2");
  });

  it("clears optional fields that are omitted", async () => {
    const a = await createJob("anni", input(1), T0);
    const edited = await updateJob("anni", a.jobId, { company: "C", jobRole: "R", jobType: "Full-time", location: "L", jobUrl: "https://jobs.example.test/1" }, T0);
    expect(edited.workMode).toBeUndefined();
    expect(edited.deadline).toBeUndefined();
    expect(sheets.dataRows("Jobs")[0].slice(4, 7)).toEqual(["", "", ""]);
  });

  it("rejects editing someone else's job and leaves the sheet unchanged", async () => {
    const a = await createJob("anni", input(1), T0);
    const snapshot = JSON.stringify(sheets.rows("Jobs"));
    for (const who of ["lukky", "rishii"] as const) {
      await expect(updateJob(who, a.jobId, input(1, { company: "Hijacked" }), T0)).rejects.toMatchObject({ code: "not_job_owner" });
    }
    expect(JSON.stringify(sheets.rows("Jobs"))).toBe(snapshot);
  });

  it("rejects unknown jobs", async () => {
    await expect(updateJob("anni", "job_missing", input(1), T0)).rejects.toMatchObject({ code: "job_not_found" });
  });

  it("detects a URL that duplicates ANOTHER job but allows keeping (or re-spelling) its own URL", async () => {
    const a = await createJob("anni", input(1), T0);
    const b = await createJob("anni", input(2), T0);
    await expect(updateJob("anni", b.jobId, input(2, { jobUrl: "https://www.jobs.example.test/1/?utm_source=x" }), T0)).rejects.toMatchObject({
      code: "duplicate_url",
      details: { existingJobId: a.jobId },
    });
    await expect(updateJob("anni", b.jobId, input(2, { jobUrl: "https://JOBS.example.test/2/" }), T0)).resolves.toMatchObject({ jobId: b.jobId });
  });

  it("does not change anyone's application status", async () => {
    const a = await createJob("anni", input(1), T0);
    await setApplicationStatus("lukky", a.jobId, { status: "Applied" }, T0);
    const appsBefore = JSON.stringify(sheets.rows("Applications"));
    await updateJob("anni", a.jobId, input(1, { company: "Corrected Co" }), T0);
    expect(JSON.stringify(sheets.rows("Applications"))).toBe(appsBefore);
    expect((await listJobsForMember("lukky")).jobs[0]).toMatchObject({ company: "Corrected Co", myStatus: "Applied" });
  });

  it("records a job_updated activity for the editor", async () => {
    const a = await createJob("anni", input(1), T0);
    await updateJob("anni", a.jobId, input(1, { company: "X" }), T0);
    const actions = (await readActivity()).items.map((i) => [i.memberId, i.action]);
    expect(actions).toEqual([["anni", "job_added"], ["anni", "job_updated"]]);
  });
});

describe("deleteJob", () => {
  it("removes the job row for everyone, leaving other jobs in place", async () => {
    const a = await createJob("anni", input(1), T0);
    const b = await createJob("anni", input(2), T0);
    const c = await createJob("anni", input(3), T0);
    await deleteJob("anni", b.jobId, T0);
    expect(sheets.dataRows("Jobs").map((r) => r[0])).toEqual([a.jobId, c.jobId]);
    for (const who of ["anni", "lukky", "rishii"] as const) {
      expect((await listJobsForMember(who)).jobs.map((j) => j.jobId).sort()).toEqual([a.jobId, c.jobId].sort());
    }
  });

  it("also removes every member's application records for that job, and only for that job", async () => {
    const a = await createJob("anni", input(1), T0);
    const b = await createJob("anni", input(2), T0);
    for (const who of ["anni", "lukky", "rishii"] as const) {
      await setApplicationStatus(who, a.jobId, { status: "Applied" }, T0);
      await setApplicationStatus(who, b.jobId, { status: "Applied", notes: `${who}-note` }, T0);
    }
    expect(sheets.dataRows("Applications")).toHaveLength(6);
    await deleteJob("anni", a.jobId, T0);
    const rows = sheets.dataRows("Applications");
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r[0] === b.jobId)).toBe(true);
    expect(rows.map((r) => r[1]).sort()).toEqual(["anni", "lukky", "rishii"]);
    expect((await listApplicationsForMember("lukky")).map((x) => x.jobId)).toEqual([b.jobId]);
    expect((await listMyApplications("rishii")).rows.map((r) => r.job.jobId)).toEqual([b.jobId]);
    // a surviving record is intact
    expect(rows.find((r) => r[1] === "lukky")![5]).toBe("lukky-note");
  });

  it("rejects non-owners and unknown jobs without deleting anything", async () => {
    const a = await createJob("anni", input(1), T0);
    await setApplicationStatus("lukky", a.jobId, { status: "Applied" }, T0);
    const snapshot = JSON.stringify([sheets.rows("Jobs"), sheets.rows("Applications")]);
    await expect(deleteJob("lukky", a.jobId, T0)).rejects.toMatchObject({ code: "not_job_owner" });
    await expect(deleteJob("rishii", a.jobId, T0)).rejects.toMatchObject({ code: "not_job_owner" });
    await expect(deleteJob("anni", "job_missing", T0)).rejects.toMatchObject({ code: "job_not_found" });
    expect(JSON.stringify([sheets.rows("Jobs"), sheets.rows("Applications")])).toBe(snapshot);
  });

  it("keeps the delete if clean-up of application rows fails: the leftover rows are hidden everywhere", async () => {
    const a = await createJob("anni", input(1), T0);
    await setApplicationStatus("lukky", a.jobId, { status: "Applied" }, T0);
    const original = sheets.deleteRows.bind(sheets);
    sheets.deleteRows = async (tab, rows) => {
      if (tab === "Applications") throw googleError(500);
      return original(tab, rows);
    };
    await expect(deleteJob("anni", a.jobId, T0)).resolves.toEqual({ jobId: a.jobId });
    expect(sheets.dataRows("Jobs")).toHaveLength(0);
    expect(sheets.dataRows("Applications")).toHaveLength(1); // orphan row remains...
    expect((await listMyApplications("lukky")).rows).toEqual([]); // ...but is never shown
    expect((await listMyApplications("lukky")).skipped).toBe(1);
  });

  it("does not claim success when removing the job row itself fails", async () => {
    const a = await createJob("anni", input(1), T0);
    sheets.failNext = { op: "delete", error: googleError(500) };
    await expect(deleteJob("anni", a.jobId, T0)).rejects.toMatchObject({ code: "upstream_error" });
    expect(sheets.dataRows("Jobs")).toHaveLength(1);
  });

  it("records a job_deleted activity and the member's daily numbers drop accordingly", async () => {
    const a = await createJob("anni", input(1), T0);
    await createJob("anni", input(2), T0);
    expect((await getDashboardData("anni", T0)).daily.addedToday).toBe(2);
    await deleteJob("anni", a.jobId, T0);
    expect((await getDashboardData("anni", T0)).daily.addedToday).toBe(1);
    const activity = (await readActivity()).items;
    expect(activity.at(-1)).toMatchObject({ memberId: "anni", action: "job_deleted" });
    // no Activity row references the deleted job any more (history is kept, the reference is cleared)
    expect(activity.some((row) => row.jobId === a.jobId)).toBe(false);
  });

  it("simultaneous edit and delete of the same job leave consistent data", async () => {
    const a = await createJob("anni", input(1), T0);
    const results = await Promise.allSettled([
      updateJob("anni", a.jobId, input(1, { company: "Edited" }), T0),
      deleteJob("anni", a.jobId, T0),
      updateJob("anni", a.jobId, input(1, { company: "Edited again" }), T0),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    // The job is deleted at the end or, if the delete ran first, later edits fail with job_not_found
    expect(sheets.dataRows("Jobs")).toHaveLength(0);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "job_not_found" });
  });

  it("deleting and re-adding a link works (the URL is free again)", async () => {
    const a = await createJob("anni", input(1), T0);
    await deleteJob("anni", a.jobId, T0);
    await expect(createJob("lukky", input(1), T0)).resolves.toMatchObject({ addedBy: "lukky" });
  });
});
