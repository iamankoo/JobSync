import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { createJob } from "@/lib/google-sheets/jobs-service";
import { listMyApplications, setApplicationStatus } from "@/lib/google-sheets/applications-service";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { FakeSheets } from "../helpers/fake-sheets";

let sheets: FakeSheets;
const T0 = new Date("2026-10-09T10:00:00.000Z");
const input = (n: number) => ({
  company: `Synthetic Co ${n}`, jobRole: "Test Role", jobType: "Internship" as const, location: "Testville",
  jobUrl: `https://jobs.example.test/${n}`,
});

beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
});
afterEach(() => setSheetsClientForTesting(null));

describe("listMyApplications", () => {
  it("returns only the caller's own applications joined with their jobs", async () => {
    const a = (await createJob("anni", input(1), T0)).jobId;
    const b = (await createJob("anni", input(2), T0)).jobId;
    await setApplicationStatus("anni", a, { status: "Applied", notes: "anni-private" }, T0);
    await setApplicationStatus("lukky", a, { status: "Applied", notes: "lukky-private" }, T0);
    await setApplicationStatus("lukky", b, { status: "Applied" }, T0);

    const anni = await listMyApplications("anni");
    expect(anni.rows.map((r) => r.job.jobId)).toEqual([a]);
    expect(anni.rows[0].application.memberId).toBe("anni");
    expect(JSON.stringify(anni)).not.toContain("lukky-private");

    const lukky = await listMyApplications("lukky");
    expect(lukky.rows.map((r) => r.job.jobId).sort()).toEqual([a, b].sort());
    expect(JSON.stringify(lukky)).not.toContain("anni-private");

    expect((await listMyApplications("rishii")).rows).toEqual([]);
  });

  it("excludes jobs moved back to Not Applied and never invents rows for untouched jobs", async () => {
    const a = (await createJob("anni", input(1), T0)).jobId;
    await createJob("anni", input(2), T0);
    expect((await listMyApplications("anni")).rows).toEqual([]);
    await setApplicationStatus("anni", a, { status: "Applied" }, T0);
    expect((await listMyApplications("anni")).rows).toHaveLength(1);
    await setApplicationStatus("anni", a, { status: "Not Applied" }, T0);
    expect((await listMyApplications("anni")).rows).toEqual([]);
  });

  it("counts, instead of showing, applications whose job no longer exists", async () => {
    const a = (await createJob("anni", input(1), T0)).jobId;
    await setApplicationStatus("anni", a, { status: "Applied" }, T0);
    sheets.rows("Jobs").splice(1, 1); // job deleted by hand in the spreadsheet
    expect(await listMyApplications("anni")).toEqual({ rows: [], skipped: 1 });
  });

  it("orders by most recently updated first", async () => {
    const a = (await createJob("anni", input(1), T0)).jobId;
    const b = (await createJob("anni", input(2), T0)).jobId;
    await setApplicationStatus("anni", a, { status: "Applied" }, new Date("2026-10-09T11:00:00Z"));
    await setApplicationStatus("anni", b, { status: "Applied" }, new Date("2026-10-09T12:00:00Z"));
    await setApplicationStatus("anni", a, { status: "In Progress" }, new Date("2026-10-09T13:00:00Z"));
    expect((await listMyApplications("anni")).rows.map((r) => r.job.jobId)).toEqual([a, b]);
  });
});
