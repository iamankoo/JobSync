import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { GET as listFollowUps } from "@/app/api/follow-ups/route";
import { POST as answerRoute } from "@/app/api/follow-ups/[jobId]/route";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import type { MemberId } from "@/config/members";
import { FakeSheets, googleError } from "../helpers/fake-sheets";

let sheets: FakeSheets;
const as = (m: MemberId | null) => vi.mocked(getSession).mockResolvedValue(m ? { memberId: m, expiresAt: 9_999_999_999 } : null);
const ctx = (jobId: string) => ({ params: Promise.resolve({ jobId }) });
const post = (data: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/follow-ups/x", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost", ...headers },
    body: typeof data === "string" ? data : JSON.stringify(data),
  });
const get = () => new Request("http://localhost/api/follow-ups", { method: "GET", headers: { host: "localhost" } });

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

/** Test-only fixture: a job and one member's application, with AppliedAt `appliedDaysAgo` days in the past. */
function seed(who: MemberId, n: number, appliedDaysAgo: number, extra: Partial<Record<"status" | "stage" | "notes", string>> = {}) {
  const jobId = `job_t${n}`;
  if (!sheets.dataRows("Jobs").some((r) => r[0] === jobId)) {
    sheets.rows("Jobs").push([jobId, `Synthetic Co ${n}`, `Test Role ${n}`, "Internship", "", "", "", "Testville", `https://jobs.example.test/${n}`, "", "", "anni", daysAgo(appliedDaysAgo + 1)]);
  }
  sheets.rows("Applications").push([jobId, who, extra.status ?? "Applied", daysAgo(appliedDaysAgo), extra.stage ?? "", extra.notes ?? "", daysAgo(appliedDaysAgo), "", ""]);
  return jobId;
}
const row = (who: MemberId, jobId: string) => sheets.dataRows("Applications").find((r) => r[0] === jobId && r[1] === who)!;

beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
});
afterEach(() => {
  setSheetsClientForTesting(null);
  vi.mocked(getSession).mockReset();
});

describe("GET /api/follow-ups", () => {
  it("requires a session", async () => {
    as(null);
    const r = await listFollowUps(get());
    expect(r.status).toBe(401);
    expect(sheets.calls).toHaveLength(0);
  });

  it("returns only the signed-in member's due follow-ups, with real job details and no private data", async () => {
    const mine = seed("anni", 1, 8, { notes: "anni-private-note" });
    seed("lukky", 2, 9, { notes: "lukky-private-note" });
    seed("anni", 3, 3); // not due yet
    as("anni");
    const body = await (await listFollowUps(get())).json();
    expect(body.data.enabled).toBe(true);
    expect(body.data.due.map((d: { jobId: string }) => d.jobId)).toEqual([mine]);
    expect(body.data.due[0]).toMatchObject({ company: "Synthetic Co 1", jobRole: "Test Role 1" });
    const text = JSON.stringify(body);
    expect(text).not.toContain("private-note");
    as("rishii");
    expect((await (await listFollowUps(get())).json()).data.due).toEqual([]);
  });

  it("shows the question again on every visit until it is answered (derived from saved data, not the browser)", async () => {
    seed("anni", 1, 8);
    as("anni");
    for (let i = 0; i < 3; i++) expect((await (await listFollowUps(get())).json()).data.due).toHaveLength(1);
  });
});

describe("POST /api/follow-ups/[jobId]", () => {
  it("requires a session and rejects cross-origin requests", async () => {
    const id = seed("anni", 1, 8);
    as(null);
    expect((await answerRoute(post({ answer: "Offer" }), ctx(id))).status).toBe(401);
    as("anni");
    expect((await answerRoute(post({ answer: "Offer" }, { origin: "http://evil.example" }), ctx(id))).status).toBe(403);
    expect(row("anni", id)[7]).toBe("");
  });

  it.each([
    ["Shortlisted", { status: "Applied", stage: "Shortlisted" }],
    ["Interview", { status: "Interview", stage: "" }],
    ["Offer", { status: "Offer", stage: "Offer" }],
    ["No update", { status: "Applied", stage: "" }],
  ] as const)("saves the %s answer through the real route and persists the resulting status/stage", async (answer, expected) => {
    const id = seed("anni", 1, 8);
    as("anni");
    const r = await answerRoute(post({ answer }), ctx(id));
    expect(r.status).toBe(200);
    const { data } = await r.json();
    expect(data).toMatchObject({ jobId: id, answer, changed: true });
    const saved = row("anni", id);
    expect([saved[2], saved[4], saved[7]]).toEqual([expected.status, expected.stage, answer]);
    expect(new Date(saved[8]).getTime()).toBeGreaterThan(Date.now() - 60_000); // server-generated timestamp
  });

  it("accepts only the answer: identity, timestamps, stage and eligibility are never taken from the client", async () => {
    const id = seed("anni", 1, 8);
    as("lukky");
    seed("lukky", 1, 8);
    for (const extra of [{ memberId: "anni" }, { MemberID: "anni" }, { appliedAt: "2020-01-01T00:00:00Z" }, { stage: "Offer" }, { due: true }, { answeredAt: "2020-01-01T00:00:00Z" }, { company: "X" }]) {
      expect((await answerRoute(post({ answer: "Offer", ...extra }), ctx(id))).status).toBe(400);
    }
    for (const bad of [{}, { answer: "Yes" }, { answer: "No" }, { answer: "offer" }, { answer: 1 }, { answer: ["Offer"] }]) {
      expect((await answerRoute(post(bad), ctx(id))).status).toBe(400);
    }
    expect((await answerRoute(post("{nope"), ctx(id))).status).toBe(400);
    expect(row("anni", id).slice(7, 9)).toEqual(["", ""]);
    expect(row("lukky", id).slice(7, 9)).toEqual(["", ""]);
  });

  it("a member can never answer another member's follow-up, even knowing the job ID", async () => {
    const id = seed("anni", 1, 8);
    for (const who of ["lukky", "rishii"] as const) {
      as(who);
      const r = await answerRoute(post({ answer: "Offer" }), ctx(id));
      expect(r.status).toBe(404);
      expect((await r.json()).error.code).toBe("follow_up_not_found");
    }
    expect(row("anni", id).slice(2, 9)).toEqual(["Applied", row("anni", id)[3], "", "", row("anni", id)[6], "", ""]);
  });

  it("each member answers independently for the same shared job", async () => {
    const id = seed("anni", 1, 8);
    seed("lukky", 1, 8);
    as("anni");
    await answerRoute(post({ answer: "Shortlisted" }), ctx(id));
    as("lukky");
    await answerRoute(post({ answer: "No update" }), ctx(id));
    expect([row("anni", id)[7], row("lukky", id)[7]]).toEqual(["Shortlisted", "No update"]);
  });

  it("returns 409 before 168 hours, for repeated different answers, and for suppressed applications", async () => {
    as("anni");
    const early = seed("anni", 1, 6);
    const r1 = await answerRoute(post({ answer: "Offer" }), ctx(early));
    expect(r1.status).toBe(409);
    expect((await r1.json()).error.code).toBe("follow_up_not_due");

    const due = seed("anni", 2, 8);
    expect((await answerRoute(post({ answer: "Shortlisted" }), ctx(due))).status).toBe(200);
    const again = await answerRoute(post({ answer: "Shortlisted" }), ctx(due));
    expect(again.status).toBe(200);
    expect((await again.json()).data.changed).toBe(false);
    const other = await answerRoute(post({ answer: "Offer" }), ctx(due));
    expect(other.status).toBe(409);
    expect((await other.json()).error.code).toBe("follow_up_conflict");

    const done = seed("anni", 3, 8, { status: "Offer" });
    const r3 = await answerRoute(post({ answer: "Shortlisted" }), ctx(done));
    expect(r3.status).toBe(409);
    expect((await r3.json()).error.code).toBe("follow_up_not_applicable");
    expect(row("anni", done)[2]).toBe("Offer");
  });

  it("returns 404 for unknown jobs and 400 for malformed IDs", async () => {
    as("anni");
    expect((await answerRoute(post({ answer: "Offer" }), ctx("job_missing"))).status).toBe(404);
    expect((await answerRoute(post({ answer: "Offer" }), ctx("../etc"))).status).toBe(400);
  });

  it("a failed save returns a safe error, keeps the question pending, and the retry works", async () => {
    const id = seed("anni", 1, 8);
    as("anni");
    sheets.failNext = { op: "update", error: googleError(500) };
    const failed = await answerRoute(post({ answer: "Shortlisted" }), ctx(id));
    expect(failed.status).toBe(502);
    expect(JSON.stringify(await failed.json())).not.toContain("SECRET-DETAIL");
    expect(row("anni", id).slice(7, 9)).toEqual(["", ""]);
    expect((await (await listFollowUps(get())).json()).data.due).toHaveLength(1);
    expect((await answerRoute(post({ answer: "Shortlisted" }), ctx(id))).status).toBe(200);
    expect((await (await listFollowUps(get())).json()).data.due).toEqual([]);
  });

  it("answers 503 (not a crash) when the sheet has no follow-up columns", async () => {
    sheets = new FakeSheets(true, false).seedMembers();
    setSheetsClientForTesting(sheets);
    resetMembersCache();
    sheets.rows("Jobs").push(["job_x", "Synthetic Co", "Test Role", "Internship", "", "", "", "Testville", "https://jobs.example.test/x", "", "", "anni", daysAgo(10)]);
    sheets.rows("Applications").push(["job_x", "anni", "Applied", daysAgo(9), "", "", daysAgo(9)]);
    as("anni");
    const r = await answerRoute(post({ answer: "Offer" }), ctx("job_x"));
    expect(r.status).toBe(503);
    expect((await listFollowUps(get())).status).toBe(200);
  });
});
