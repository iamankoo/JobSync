import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { setApplicationStatus } from "@/lib/google-sheets/applications-service";
import { answerFollowUp, getDueFollowUps } from "@/lib/google-sheets/follow-up-service";
import { getAnalyticsSource, getDashboardData } from "@/lib/google-sheets/insights-service";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { readApplications } from "@/lib/google-sheets/repositories";
import { effectiveAppliedAt } from "@/lib/applications/applied-date";
import { computeAnalytics } from "@/lib/analytics/analytics";
import { evaluateFollowUp } from "@/lib/follow-ups/rules";
import { FakeSheets } from "../helpers/fake-sheets";

/**
 * Legacy rows (hand-made or written before AppliedAt existed) have no AppliedAt. This pins down
 * how they behave: reporting uses ONE fallback (LastUpdated), the follow-up never does.
 */
const NOW = new Date("2026-10-11T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
let sheets: FakeSheets;

function job(n: number, addedAt = hoursAgo(500)) {
  return [`job_${n}`, `Co ${n}`, `Role ${n}`, "Full-time", "", "Fresher", "", "Hybrid", `https://example.test/${n}`, "", "", "lukky", addedAt];
}
const legacy = (n: number, status: string, lastUpdated: string, appliedAt = "") => [`job_${n}`, "anni", status, appliedAt, "", "", lastUpdated];

beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
});
afterEach(() => setSheetsClientForTesting(null));

describe("effectiveAppliedAt", () => {
  it("prefers the recorded AppliedAt, then LastUpdated, and never invents a date", () => {
    expect(effectiveAppliedAt({ appliedAt: "2026-10-01T10:00:00.000Z", lastUpdated: "2026-10-05T10:00:00.000Z" })).toEqual({ iso: "2026-10-01T10:00:00.000Z", source: "recorded" });
    expect(effectiveAppliedAt({ lastUpdated: "2026-10-05T10:00:00.000Z" })).toEqual({ iso: "2026-10-05T10:00:00.000Z", source: "fallback" });
    expect(effectiveAppliedAt({ appliedAt: "not a date", lastUpdated: "2026-10-05T10:00:00.000Z" })).toEqual({ iso: "2026-10-05T10:00:00.000Z", source: "fallback" });
    expect(effectiveAppliedAt({ appliedAt: "x", lastUpdated: "y" })).toEqual({ source: "unknown" });
    expect(effectiveAppliedAt({})).toEqual({ source: "unknown" });
  });
});

describe("legacy rows without AppliedAt", () => {
  beforeEach(async () => {
    await sheets.appendValues("Jobs!A:M", [job(1), job(2), job(3)]);
    await sheets.appendValues("Applications!A:I", [
      legacy(1, "Applied", hoursAgo(400)), // legacy, applied long ago: still NOT prompted
      legacy(2, "Applied", hoursAgo(10), ""), // legacy, recent
      legacy(3, "Applied", hoursAgo(400), "garbage"), // invalid AppliedAt behaves as missing
    ]);
  });

  it("are never prompted for a follow-up, however old LastUpdated is (no premature or guessed prompt)", async () => {
    expect(await getDueFollowUps("anni", NOW)).toEqual({ enabled: true, due: [], invalid: 3 });
    const apps = (await readApplications({ fresh: true })).items;
    for (const a of apps) expect(evaluateFollowUp(a, { addedAt: hoursAgo(500) }, NOW)).toEqual({ state: "invalid", reason: "missing_applied_at" });
    await expect(answerFollowUp("anni", "job_1", "Shortlisted", NOW)).rejects.toMatchObject({ code: expect.stringMatching(/follow_up/) });
    expect(sheets.dataRows("Applications")[0][7] ?? "").toBe(""); // nothing written
  });

  it("Dashboard and Analytics use the SAME fallback date and still count the application once", async () => {
    const dash = await getDashboardData("anni", NOW);
    const src = await getAnalyticsSource("anni", NOW);
    expect(dash.myApplied).toBe(3);
    expect(src.applications).toHaveLength(3);
    // the timeline's "Job Applied" for the fallback day comes from the same dates
    const byId = Object.fromEntries(src.applications.map((a) => [a.jobId, a.appliedDate]));
    expect(byId.job_1).toBe("2026-09-25"); // LastUpdated (400 h before NOW), app timezone
    expect(byId.job_2).toBe("2026-10-11");
    const r = computeAnalytics(src, "all");
    expect(r.cards.find((c) => c.key === "applied")!.value).toBe(3);
    expect(r.activity.weeks.flat().find((c) => c?.date === "2026-10-11")!.submitted).toBe(1);
  });

  it("a later real update stamps AppliedAt once (now) and the follow-up clock starts from that real time", async () => {
    await setApplicationStatus("anni", "job_1", { status: "In Progress", applicationStage: "Screening" }, NOW);
    const row = sheets.dataRows("Applications").find((r) => r[0] === "job_1")!;
    expect(row[3]).toBe(NOW.toISOString()); // AppliedAt now exists
    expect((await getDueFollowUps("anni", new Date(NOW.getTime() + 167 * 3_600_000))).due).toEqual([]);
    expect((await getDueFollowUps("anni", new Date(NOW.getTime() + 168 * 3_600_000))).due.map((d) => d.jobId)).toEqual(["job_1"]);
  });

  it("existing rows are not altered by reading", async () => {
    const before = JSON.stringify(sheets.dataRows("Applications"));
    await getDueFollowUps("anni", NOW);
    await getDashboardData("anni", NOW);
    await getAnalyticsSource("anni", NOW);
    expect(JSON.stringify(sheets.dataRows("Applications"))).toBe(before);
  });
});

describe("follow-up answers do not alter other records", () => {
  it("answering one job changes only that row (legacy 7-column rows beside it are byte-identical)", async () => {
    await sheets.appendValues("Jobs!A:M", [job(1), job(2)]);
    await sheets.appendValues("Applications!A:I", [
      legacy(1, "Applied", hoursAgo(300), hoursAgo(300)),
      ["job_2", "lukky", "Applied", hoursAgo(5), "", "keep me", hoursAgo(5)],
    ]);
    const untouched = JSON.stringify(sheets.dataRows("Applications")[1]);
    const res = await answerFollowUp("anni", "job_1", "Interview", NOW);
    expect(res).toBeTruthy();
    expect(JSON.stringify(sheets.dataRows("Applications")[1])).toBe(untouched);
    const answered = sheets.dataRows("Applications")[0];
    expect(answered.slice(0, 2)).toEqual(["job_1", "anni"]);
    expect(answered[7]).toBe("Interview");
    expect(answered[8]).toBe(NOW.toISOString());
  });
});
