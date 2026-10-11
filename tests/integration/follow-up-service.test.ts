import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { createJob, listJobsForMember } from "@/lib/google-sheets/jobs-service";
import { listMyApplications, setApplicationStatus } from "@/lib/google-sheets/applications-service";
import { answerFollowUp, getDueFollowUps } from "@/lib/google-sheets/follow-up-service";
import { getAnalyticsSource, getDashboardData } from "@/lib/google-sheets/insights-service";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { readActivity, readApplications } from "@/lib/google-sheets/repositories";
import { computeAnalytics } from "@/lib/analytics/analytics";
import { countApplications, notAppliedCount } from "@/lib/counting";
import { FOLLOW_UP_AFTER_SECONDS } from "@/lib/follow-ups/rules";
import type { MemberId } from "@/config/members";
import type { CreateJobInput } from "@/lib/validation/jobs";
import { FakeSheets, googleError } from "../helpers/fake-sheets";

let sheets: FakeSheets;
const T0 = new Date("2026-10-01T10:00:00.000Z"); // when the first application is recorded
const hoursAfter = (h: number, from: Date = T0) => new Date(from.getTime() + h * 3_600_000);
const DUE = hoursAfter(168);

const input = (n: number): CreateJobInput => ({
  company: `Synthetic Co ${n}`, jobRole: `Test Role ${n}`, jobType: "Internship", location: "Testville",
  experience: "0–1 years", jobUrl: `https://jobs.example.test/${n}`,
});

async function addJob(n: number, by: MemberId = "anni", at: Date = T0) {
  return (await createJob(by, input(n), at)).jobId;
}
const apply = (who: MemberId, jobId: string, at: Date = T0) => setApplicationStatus(who, jobId, { status: "Applied" }, at);
const appRow = (who: MemberId, jobId: string) => sheets.dataRows("Applications").find((r) => r[0] === jobId && r[1] === who)!;
// Applications columns: 0 JobID 1 MemberID 2 Status 3 AppliedAt 4 Stage 5 Notes 6 LastUpdated 7 FollowUpAnswer 8 FollowUpAnsweredAt

/** The numbers every page shows for one member, from the SAME persisted data. */
async function numbers(who: MemberId, now: Date) {
  const dash = await getDashboardData(who, now);
  const a = computeAnalytics(await getAnalyticsSource(who, now), "all");
  const jobs = await listJobsForMember(who);
  const fromJobs = countApplications(jobs.jobs.map((j) => ({ jobId: j.jobId, status: j.myStatus, applicationStage: j.myStage, followUpAnswer: j.myFollowUpAnswer })));
  const mine = await listMyApplications(who);
  const card = (key: string) => a.cards.find((c) => c.key === key)!.value;
  return {
    dash: {
      totalJobs: dash.totalJobs, applied: dash.myApplied, pending: dash.myPending,
      shortlisted: dash.daily.shortlisted, interviewed: dash.daily.interviewed, offers: dash.daily.offers,
    },
    analytics: {
      total: card("total"), applied: card("applied"), inProgress: card("inProgress"), shortlisted: card("shortlisted"),
      interviewed: card("interviewed"), offers: card("offers"), rejected: card("rejected"),
    },
    allJobs: { total: jobs.jobs.length, applied: fromJobs.applied, pending: fromJobs.pending, notApplied: notAppliedCount(jobs.jobs.length, fromJobs.applied) },
    myApplications: mine.rows.length,
  };
}

beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
});
afterEach(() => setSheetsClientForTesting(null));

describe("when a follow-up becomes due", () => {
  it("adding a job (without applying) never starts a timer", async () => {
    await addJob(1);
    for (const who of ["anni", "lukky", "rishii"] as const) {
      expect((await getDueFollowUps(who, hoursAfter(24 * 30 - 1))).due).toEqual([]);
    }
    expect(sheets.dataRows("Applications")).toHaveLength(0);
  });

  it("starts at the server's Applied time and is due exactly 168 hours later, not before", async () => {
    const jobId = await addJob(1);
    await apply("anni", jobId);
    expect(appRow("anni", jobId)[3]).toBe("2026-10-01T10:00:00.000Z"); // server-generated AppliedAt
    expect((await getDueFollowUps("anni", new Date(DUE.getTime() - 1))).due).toEqual([]);
    const due = (await getDueFollowUps("anni", DUE)).due;
    expect(due).toEqual([{ jobId, company: "Synthetic Co 1", jobRole: "Test Role 1", location: "Testville", appliedAt: "2026-10-01T10:00:00.000Z", dueAt: "2026-10-08T10:00:00.000Z" }]);
    expect(FOLLOW_UP_AFTER_SECONDS).toBe(604_800);
  });

  it("survives refreshes, logout/login and a server restart (it is derived from saved data)", async () => {
    const jobId = await addJob(1);
    await apply("anni", jobId);
    const first = await getDueFollowUps("anni", hoursAfter(200));
    // 'restart': drop every in-memory cache and reconnect to the same spreadsheet
    setSheetsClientForTesting(null);
    resetMembersCache();
    setSheetsClientForTesting(sheets);
    for (let i = 0; i < 3; i++) expect(await getDueFollowUps("anni", hoursAfter(200 + i))).toMatchObject({ due: first.due });
  });

  it("each member has an independent application, timer and question for the same shared job", async () => {
    const jobId = await addJob(1);
    await apply("anni", jobId, T0);
    await apply("lukky", jobId, hoursAfter(48));
    expect((await getDueFollowUps("anni", DUE)).due.map((d) => d.jobId)).toEqual([jobId]);
    expect((await getDueFollowUps("lukky", DUE)).due).toEqual([]); // applied 2 days later: not yet
    expect((await getDueFollowUps("lukky", hoursAfter(48 + 168))).due.map((d) => d.jobId)).toEqual([jobId]);
    expect((await getDueFollowUps("rishii", hoursAfter(24 * 20))).due).toEqual([]); // never applied
  });

  it("applying again after Not Applied starts a NEW timer and clears the old answer", async () => {
    const jobId = await addJob(1);
    await apply("anni", jobId);
    await answerFollowUp("anni", jobId, "Shortlisted", DUE);
    await setApplicationStatus("anni", jobId, { status: "Not Applied" }, hoursAfter(200));
    expect(appRow("anni", jobId).slice(3, 9)).toEqual(["", "", "", expect.any(String), "", ""]); // appliedAt, stage, notes cleared; answer cleared
    await apply("anni", jobId, hoursAfter(300));
    expect(appRow("anni", jobId)[3]).toBe(hoursAfter(300).toISOString());
    expect((await getDueFollowUps("anni", hoursAfter(300 + 167))).due).toEqual([]);
    expect((await getDueFollowUps("anni", hoursAfter(300 + 168))).due).toHaveLength(1);
  });

  it("editing notes or stage never resets the timer or an answer", async () => {
    const jobId = await addJob(1);
    await apply("anni", jobId);
    await setApplicationStatus("anni", jobId, { status: "Applied", notes: "note", applicationStage: "Screening" }, hoursAfter(24));
    expect(appRow("anni", jobId)[3]).toBe(T0.toISOString());
    expect((await getDueFollowUps("anni", DUE)).due).toHaveLength(1);
    await answerFollowUp("anni", jobId, "No update", DUE);
    await setApplicationStatus("anni", jobId, { status: "Applied", notes: "changed" }, hoursAfter(200));
    expect(appRow("anni", jobId).slice(7, 9)).toEqual(["No update", DUE.toISOString()]);
  });

  it("an unanswered follow-up is cancelled when the job is marked Not Applied", async () => {
    const jobId = await addJob(1);
    await apply("anni", jobId);
    await setApplicationStatus("anni", jobId, { status: "Not Applied" }, hoursAfter(100));
    expect((await getDueFollowUps("anni", hoursAfter(500))).due).toEqual([]);
    await expect(answerFollowUp("anni", jobId, "Shortlisted", hoursAfter(500))).rejects.toMatchObject({ code: "follow_up_not_applicable" });
  });

  it("applications already at Interview/Offer/Rejected are never asked", async () => {
    const ids = [await addJob(1), await addJob(2), await addJob(3)];
    for (const id of ids) await apply("anni", id);
    await setApplicationStatus("anni", ids[0], { status: "Interview" }, hoursAfter(24));
    await setApplicationStatus("anni", ids[1], { status: "Offer" }, hoursAfter(24));
    await setApplicationStatus("anni", ids[2], { status: "Rejected" }, hoursAfter(24));
    expect((await getDueFollowUps("anni", hoursAfter(500))).due).toEqual([]);
  });

  it("a job past its 30-day life is never asked about", async () => {
    const jobId = await addJob(1, "anni", new Date("2026-08-01T00:00:00Z"));
    await apply("anni", jobId, new Date("2026-08-02T00:00:00Z"));
    expect((await getDueFollowUps("anni", new Date("2026-09-15T00:00:00Z"))).due).toEqual([]); // applied >7 days ago but job expired
    expect((await getDueFollowUps("anni", new Date("2026-08-10T00:00:00Z"))).due).toHaveLength(1); // while the job still lives
  });

  it("an application with a missing/invalid AppliedAt is skipped safely (reported, never prompted)", async () => {
    const jobId = await addJob(1);
    await apply("anni", jobId);
    sheets.rows("Applications")[1][3] = "last tuesday";
    const o = await getDueFollowUps("anni", hoursAfter(500));
    expect(o).toMatchObject({ enabled: true, due: [], invalid: 1 }); // reported as a safe diagnostic, never prompted
    sheets.rows("Applications")[1][3] = "";
    expect(await getDueFollowUps("anni", hoursAfter(500))).toMatchObject({ due: [], invalid: 1 });
  });

  it("several due jobs are listed oldest-due first", async () => {
    const [a, b, c] = [await addJob(1), await addJob(2), await addJob(3)];
    await apply("anni", b, hoursAfter(10));
    await apply("anni", c, hoursAfter(20));
    await apply("anni", a, hoursAfter(30));
    const due = (await getDueFollowUps("anni", hoursAfter(30 + 168))).due.map((d) => d.jobId);
    expect(due).toEqual([b, c, a]);
  });
});

describe("answering", () => {
  let jobId: string;
  beforeEach(async () => {
    jobId = await addJob(1);
    await apply("anni", jobId);
  });

  it("Shortlisted saves the answer and sets the stage to Shortlisted (status unchanged)", async () => {
    const r = await answerFollowUp("anni", jobId, "Shortlisted", DUE);
    expect(r).toMatchObject({ changed: true, answer: "Shortlisted" });
    expect(appRow("anni", jobId)).toEqual([jobId, "anni", "Applied", T0.toISOString(), "Shortlisted", "", DUE.toISOString(), "Shortlisted", DUE.toISOString()]);
  });

  it("Interview saves the answer and sets the canonical Interview status", async () => {
    await answerFollowUp("anni", jobId, "Interview", DUE);
    expect(appRow("anni", jobId)).toEqual([jobId, "anni", "Interview", T0.toISOString(), "", "", DUE.toISOString(), "Interview", DUE.toISOString()]);
  });

  it("Offer saves the answer and sets the canonical Offer status and stage", async () => {
    await answerFollowUp("anni", jobId, "Offer", DUE);
    expect(appRow("anni", jobId)).toEqual([jobId, "anni", "Offer", T0.toISOString(), "Offer", "", DUE.toISOString(), "Offer", DUE.toISOString()]);
  });

  it("No update saves only the answer and its timestamp; stage and status are untouched; it is counted as rejected (not shortlisted), no longer pending", async () => {
    await setApplicationStatus("anni", jobId, { status: "In Progress", applicationStage: "Screening" }, hoursAfter(24));
    const before = appRow("anni", jobId).slice(0, 6);
    await answerFollowUp("anni", jobId, "No update", DUE);
    const row = appRow("anni", jobId);
    expect(row.slice(0, 6)).toEqual(before); // JobID, member, status, appliedAt, stage, notes unchanged
    expect(row.slice(7, 9)).toEqual(["No update", DUE.toISOString()]);
    expect((await numbers("anni", DUE)).dash).toMatchObject({ applied: 1, pending: 0 });
    expect((await numbers("anni", DUE)).analytics).toMatchObject({ applied: 1, inProgress: 1, rejected: 1 });
  });

  it("the answer timestamp is generated by the server clock, and an answered question never returns", async () => {
    await answerFollowUp("anni", jobId, "No update", hoursAfter(170));
    expect(appRow("anni", jobId)[8]).toBe(hoursAfter(170).toISOString());
    for (const h of [170, 500, 5000]) expect((await getDueFollowUps("anni", hoursAfter(h))).due).toEqual([]);
  });

  it("rejects an answer before 168 hours and leaves the row untouched", async () => {
    const snapshot = JSON.stringify(sheets.rows("Applications"));
    await expect(answerFollowUp("anni", jobId, "Offer", new Date(DUE.getTime() - 1))).rejects.toMatchObject({ code: "follow_up_not_due" });
    expect(JSON.stringify(sheets.rows("Applications"))).toBe(snapshot);
  });

  it("retrying the same answer is a safe no-op: no double write, no double count, one activity row", async () => {
    await answerFollowUp("anni", jobId, "Shortlisted", DUE);
    const row = [...appRow("anni", jobId)];
    const again = await answerFollowUp("anni", jobId, "Shortlisted", hoursAfter(200));
    expect(again.changed).toBe(false);
    expect(appRow("anni", jobId)).toEqual(row); // timestamp not rewritten
    expect((await numbers("anni", DUE)).dash.shortlisted).toBe(1);
    expect((await readActivity()).items.filter((a) => a.action === "follow_up_answered")).toHaveLength(1);
  });

  it("a different answer after one was saved is rejected: no contradictory answers", async () => {
    await answerFollowUp("anni", jobId, "Shortlisted", DUE);
    await expect(answerFollowUp("anni", jobId, "Offer", hoursAfter(200))).rejects.toMatchObject({ code: "follow_up_conflict" });
    expect(appRow("anni", jobId)[7]).toBe("Shortlisted");
    expect(appRow("anni", jobId)[2]).toBe("Applied");
  });

  it("simultaneous duplicate submissions produce one write; simultaneous contradictory ones produce one winner", async () => {
    const same = await Promise.allSettled([1, 2, 3].map(() => answerFollowUp("anni", jobId, "Shortlisted", DUE)));
    expect(same.every((r) => r.status === "fulfilled")).toBe(true);
    expect(same.filter((r) => r.status === "fulfilled" && r.value.changed)).toHaveLength(1);
    expect(sheets.dataRows("Applications")).toHaveLength(1);

    const j2 = await addJob(2);
    await apply("anni", j2);
    const mixed = await Promise.allSettled([answerFollowUp("anni", j2, "Shortlisted", DUE), answerFollowUp("anni", j2, "Offer", DUE)]);
    expect(mixed.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(mixed.filter((r) => r.status === "rejected" && (r.reason as { code: string }).code === "follow_up_conflict")).toHaveLength(1);
    expect(["Shortlisted", "Offer"]).toContain(appRow("anni", j2)[7]);
  });

  it("a failed save leaves the question pending and writes no activity", async () => {
    sheets.failNext = { op: "update", error: googleError(500) };
    await expect(answerFollowUp("anni", jobId, "Shortlisted", DUE)).rejects.toMatchObject({ code: "upstream_error" });
    expect(appRow("anni", jobId).slice(7, 9)).toEqual(["", ""]);
    expect((await getDueFollowUps("anni", DUE)).due).toHaveLength(1); // still asked
    expect((await readActivity()).items.some((a) => a.action === "follow_up_answered")).toBe(false);
    // and a retry then succeeds
    await expect(answerFollowUp("anni", jobId, "Shortlisted", DUE)).resolves.toMatchObject({ changed: true });
  });

  it("records one follow_up_answered activity for the member", async () => {
    await answerFollowUp("anni", jobId, "Offer", DUE);
    const rows = (await readActivity()).items.filter((a) => a.action === "follow_up_answered");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ memberId: "anni", jobId });
  });
});

describe("never downgrades", () => {
  it("an already-shortlisted application answering Shortlisted keeps its stage; answering Interview moves the status forward", async () => {
    const jobId = await addJob(1);
    await apply("anni", jobId);
    await setApplicationStatus("anni", jobId, { status: "Applied", applicationStage: "Shortlisted" }, hoursAfter(24));
    await answerFollowUp("anni", jobId, "Shortlisted", DUE);
    expect(appRow("anni", jobId).slice(2, 5)).toEqual(["Applied", T0.toISOString(), "Shortlisted"]);

    const j2 = await addJob(2);
    await apply("anni", j2);
    await setApplicationStatus("anni", j2, { status: "Applied", applicationStage: "Shortlisted" }, hoursAfter(24));
    await answerFollowUp("anni", j2, "Interview", DUE);
    expect(appRow("anni", j2)[2]).toBe("Interview");
    expect(appRow("anni", j2)[4]).toBe("Shortlisted"); // earlier stage kept, never overwritten by a lower one
  });

  it("a delayed answer after a manual move to Offer is rejected and cannot downgrade it", async () => {
    const jobId = await addJob(1);
    await apply("anni", jobId);
    await setApplicationStatus("anni", jobId, { status: "Offer", applicationStage: "Offer" }, hoursAfter(100));
    await expect(answerFollowUp("anni", jobId, "Shortlisted", DUE)).rejects.toMatchObject({ code: "follow_up_not_applicable" });
    expect(appRow("anni", jobId).slice(2, 5)).toEqual(["Offer", T0.toISOString(), "Offer"]);
  });
});

describe("authentication and isolation", () => {
  it("members only ever see and answer their own follow-ups", async () => {
    const jobId = await addJob(1);
    await apply("anni", jobId);
    await apply("lukky", jobId);
    // Lukky answers his own; Anni's row is untouched
    await answerFollowUp("lukky", jobId, "Offer", DUE);
    expect(appRow("anni", jobId).slice(2, 9)).toEqual(["Applied", T0.toISOString(), "", "", T0.toISOString(), "", ""]);
    expect(appRow("lukky", jobId)[7]).toBe("Offer");
    expect((await getDueFollowUps("anni", DUE)).due.map((d) => d.jobId)).toEqual([jobId]);
    expect((await getDueFollowUps("lukky", DUE)).due).toEqual([]);
    expect((await getDueFollowUps("rishii", DUE)).due).toEqual([]);
  });

  it("a member without an application for the job cannot answer anything (no access to another member's row)", async () => {
    const jobId = await addJob(1);
    await apply("anni", jobId);
    const snapshot = JSON.stringify(sheets.rows("Applications"));
    await expect(answerFollowUp("rishii", jobId, "Offer", DUE)).rejects.toMatchObject({ code: "follow_up_not_found" });
    await expect(answerFollowUp("lukky", jobId, "Offer", DUE)).rejects.toMatchObject({ code: "follow_up_not_found" });
    expect(JSON.stringify(sheets.rows("Applications"))).toBe(snapshot);
  });

  it("unknown jobs are not found", async () => {
    await expect(answerFollowUp("anni", "job_missing", "Shortlisted", DUE)).rejects.toMatchObject({ code: "follow_up_not_found" });
  });
});

describe("sheet without the follow-up columns", () => {
  beforeEach(() => {
    sheets = new FakeSheets(true, false).seedMembers();
    setSheetsClientForTesting(sheets);
    resetMembersCache();
  });

  it("everything else keeps working; follow-ups are simply off and nothing is written beyond column G", async () => {
    const jobId = await addJob(1);
    await apply("anni", jobId);
    await setApplicationStatus("anni", jobId, { status: "Interview", notes: "n" }, hoursAfter(30));
    expect(sheets.dataRows("Applications")[0]).toHaveLength(7);
    expect(await getDueFollowUps("anni", hoursAfter(500))).toEqual({ enabled: false, due: [], invalid: 0 });
    await expect(answerFollowUp("anni", jobId, "Shortlisted", hoursAfter(500))).rejects.toMatchObject({ code: "follow_ups_unavailable" });
  });
});

describe("persisted data and every page agree (exact counts)", () => {
  it("1. adding a shared job without applying: counts are honest zeros for everyone, total jobs is 1", async () => {
    await addJob(1);
    for (const who of ["anni", "lukky", "rishii"] as const) {
      const n = await numbers(who, T0);
      expect(n.dash).toEqual({ totalJobs: 1, applied: 0, pending: 0, shortlisted: 0, interviewed: 0, offers: 0 });
      // Total Applications = every job available to the team, applied or not
      expect(n.analytics).toEqual({ total: 1, applied: 0, inProgress: 0, shortlisted: 0, interviewed: 0, offers: 0, rejected: 0 });
      expect(n.allJobs).toEqual({ total: 1, applied: 0, pending: 0, notApplied: 1 });
      expect(n.myApplications).toBe(0);
    }
  });

  it("2-3. marking Applied counts immediately and stays Pending for days; other members are unaffected", async () => {
    const jobId = await addJob(1);
    await apply("anni", jobId);
    for (const at of [T0, hoursAfter(24 * 3), hoursAfter(167)]) {
      const n = await numbers("anni", at);
      expect(n.dash).toEqual({ totalJobs: 1, applied: 1, pending: 1, shortlisted: 0, interviewed: 0, offers: 0 });
      expect(n.analytics).toEqual({ total: 1, applied: 1, inProgress: 0, shortlisted: 0, interviewed: 0, offers: 0, rejected: 0 });
      expect(n.allJobs).toEqual({ total: 1, applied: 1, pending: 1, notApplied: 0 });
      expect(n.myApplications).toBe(1);
    }
    expect((await numbers("lukky", T0)).dash.applied).toBe(0);
    expect((await numbers("rishii", T0)).allJobs).toEqual({ total: 1, applied: 0, pending: 0, notApplied: 1 });
  });

  it.each([
    ["Shortlisted", { shortlisted: 1, interviewed: 0, offers: 0, pending: 1, rejected: 0 }],
    ["Interview", { shortlisted: 0, interviewed: 1, offers: 0, pending: 1, rejected: 0 }],
    ["Offer", { shortlisted: 0, interviewed: 0, offers: 1, pending: 0, rejected: 0 }],
    ["No update", { shortlisted: 0, interviewed: 0, offers: 0, pending: 0, rejected: 1 }],
  ] as const)("4. answering %s updates every page to the exact same numbers", async (answer, expected) => {
    const jobId = await addJob(1);
    await apply("anni", jobId);
    await answerFollowUp("anni", jobId, answer, DUE);
    const n = await numbers("anni", DUE);
    const { rejected, ...dashExpected } = expected;
    expect(n.dash).toEqual({ totalJobs: 1, applied: 1, ...dashExpected });
    expect(n.analytics).toMatchObject({ total: 1, applied: 1, shortlisted: expected.shortlisted, interviewed: expected.interviewed, offers: expected.offers, rejected });
    expect(n.allJobs).toMatchObject({ total: 1, applied: 1, pending: expected.pending, notApplied: 0 });
    expect(n.myApplications).toBe(1);
    // the persisted sheet agrees
    expect(appRow("anni", jobId)[7]).toBe(answer);
    // and so does a reload (fresh instance, same data)
    setSheetsClientForTesting(null);
    resetMembersCache();
    setSheetsClientForTesting(sheets);
    expect((await numbers("anni", hoursAfter(1000))).dash).toEqual({ totalJobs: 1, applied: 1, ...dashExpected });
  });

  it("5. marking another job Not Applied changes no application count", async () => {
    const a = await addJob(1);
    const b = await addJob(2);
    await apply("anni", a);
    await apply("anni", b);
    await setApplicationStatus("anni", b, { status: "Not Applied" }, hoursAfter(1));
    const n = await numbers("anni", hoursAfter(2));
    expect(n.dash).toMatchObject({ totalJobs: 2, applied: 1, pending: 1 });
    expect(n.allJobs).toEqual({ total: 2, applied: 1, pending: 1, notApplied: 1 });
    expect(n.myApplications).toBe(1);
  });

  it("6. switching members: each sees the shared total and only their own application counts", async () => {
    const a = await addJob(1, "anni");
    const b = await addJob(2, "lukky");
    await apply("anni", a);
    await apply("anni", b);
    await apply("lukky", a);
    await answerFollowUp("anni", a, "Shortlisted", DUE);
    await answerFollowUp("lukky", a, "Offer", DUE);
    const anni = await numbers("anni", DUE);
    const lukky = await numbers("lukky", DUE);
    const rishii = await numbers("rishii", DUE);
    expect(anni.dash).toEqual({ totalJobs: 2, applied: 2, pending: 2, shortlisted: 1, interviewed: 0, offers: 0 });
    expect(lukky.dash).toEqual({ totalJobs: 2, applied: 1, pending: 0, shortlisted: 0, interviewed: 0, offers: 1 });
    expect(rishii.dash).toEqual({ totalJobs: 2, applied: 0, pending: 0, shortlisted: 0, interviewed: 0, offers: 0 });
    expect(anni.allJobs.notApplied).toBe(0);
    expect(lukky.allJobs.notApplied).toBe(1);
    expect(rishii.allJobs.notApplied).toBe(2);
  });

  it("8. repeating requests and duplicate submissions never inflate a count", async () => {
    const jobId = await addJob(1);
    for (let i = 0; i < 3; i++) await apply("anni", jobId, hoursAfter(i));
    await Promise.all([1, 2, 3].map(() => answerFollowUp("anni", jobId, "Shortlisted", DUE)));
    expect(sheets.dataRows("Applications")).toHaveLength(1);
    expect((await readApplications()).items).toHaveLength(1);
    expect((await numbers("anni", DUE)).dash).toMatchObject({ applied: 1, shortlisted: 1 });
  });

  it("a stage change moves the application between categories (never counted twice)", async () => {
    const jobId = await addJob(1);
    await apply("anni", jobId);
    const states: [Parameters<typeof setApplicationStatus>[2], { shortlisted: number; interviewed: number; offers: number }][] = [
      [{ status: "Applied", applicationStage: "Shortlisted" }, { shortlisted: 1, interviewed: 0, offers: 0 }],
      [{ status: "Interview" }, { shortlisted: 0, interviewed: 1, offers: 0 }],
      [{ status: "Offer", applicationStage: "Offer" }, { shortlisted: 0, interviewed: 0, offers: 1 }],
    ];
    let h = 1;
    for (const [update, expected] of states) {
      await setApplicationStatus("anni", jobId, update, hoursAfter(h++));
      const d = (await numbers("anni", hoursAfter(h))).dash;
      expect({ shortlisted: d.shortlisted, interviewed: d.interviewed, offers: d.offers }).toEqual(expected);
      expect(d.applied).toBe(1);
    }
  });
});
