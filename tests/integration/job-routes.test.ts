import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { POST as postJob, GET as listJobs } from "@/app/api/jobs/route";
import { PUT as putJob, DELETE as deleteJobRoute } from "@/app/api/jobs/[jobId]/route";
import { PUT as putApp } from "@/app/api/applications/[jobId]/route";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import type { MemberId } from "@/config/members";
import { FakeSheets, googleError } from "../helpers/fake-sheets";

let sheets: FakeSheets;
const as = (m: MemberId | null) => vi.mocked(getSession).mockResolvedValue(m ? { memberId: m, expiresAt: 9_999_999_999 } : null);
const body = (over: Record<string, unknown> = {}) => ({
  company: "Synthetic Co", jobRole: "Test Role", jobType: "Internship", location: "Testville", experience: "0–1 years",
  jobUrl: "https://jobs.example.test/1", ...over,
});
const req = (method: string, data?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/jobs/x", {
    method,
    headers: { "content-type": "application/json", host: "localhost", ...headers },
    body: data === undefined ? undefined : typeof data === "string" ? data : JSON.stringify(data),
  });
const ctx = (jobId: string) => ({ params: Promise.resolve({ jobId }) });

async function add(member: MemberId, over: Record<string, unknown> = {}): Promise<string> {
  as(member);
  const res = await postJob(req("POST", body(over)));
  expect(res.status).toBe(201);
  return (await res.json()).data.jobId;
}

beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
});
afterEach(() => {
  setSheetsClientForTesting(null);
  vi.mocked(getSession).mockReset();
});

describe("PUT /api/jobs/[jobId]", () => {
  it("requires a session", async () => {
    const id = await add("anni");
    as(null);
    const r = await putJob(req("PUT", body()), ctx(id));
    expect(r.status).toBe(401);
  });

  it("lets the owner edit and returns the saved job", async () => {
    const id = await add("anni");
    as("anni");
    const r = await putJob(req("PUT", body({ company: "Corrected Co", workMode: "Hybrid" })), ctx(id));
    expect(r.status).toBe(200);
    const { data } = await r.json();
    expect(data).toMatchObject({ jobId: id, company: "Corrected Co", workMode: "Hybrid", addedBy: "anni" });
    expect(sheets.dataRows("Jobs")[0][1]).toBe("Corrected Co");
  });

  it("returns 403 for a member who did not add the job, and changes nothing", async () => {
    const id = await add("anni");
    const snapshot = JSON.stringify(sheets.rows("Jobs"));
    for (const who of ["lukky", "rishii"] as const) {
      as(who);
      const r = await putJob(req("PUT", body({ company: "Hijacked" })), ctx(id));
      expect(r.status).toBe(403);
      expect((await r.json()).error.code).toBe("not_job_owner");
    }
    expect(JSON.stringify(sheets.rows("Jobs"))).toBe(snapshot);
  });

  it("rejects client-supplied identity or server-controlled fields (strict body)", async () => {
    const id = await add("anni");
    as("lukky");
    for (const extra of [{ addedBy: "lukky" }, { memberId: "lukky" }, { jobId: "job_other" }, { addedAt: "2020-01-01T00:00:00Z" }]) {
      const r = await putJob(req("PUT", body(extra)), ctx(id));
      expect(r.status).toBe(400);
    }
    expect(sheets.dataRows("Jobs")[0][11]).toBe("anni");
  });

  it("validates fields, ids, JSON, size and origin", async () => {
    const id = await add("anni");
    as("anni");
    expect((await putJob(req("PUT", body({ jobUrl: "javascript:alert(1)" })), ctx(id))).status).toBe(400);
    expect((await putJob(req("PUT", body({ deadline: "2026-02-30" })), ctx(id))).status).toBe(400);
    expect((await putJob(req("PUT", "{nope"), ctx(id))).status).toBe(400);
    expect((await putJob(req("PUT", body({ description: "x".repeat(40_000) })), ctx(id))).status).toBe(413);
    expect((await putJob(req("PUT", body()), ctx("../../etc"))).status).toBe(400);
    expect((await putJob(req("PUT", body(), { origin: "http://evil.example" }), ctx(id))).status).toBe(403);
    expect((await putJob(req("PUT", body()), ctx("job_missing"))).status).toBe(404);
  });

  it("returns 409 with the clashing job when the new link duplicates another job", async () => {
    await add("anni", { jobUrl: "https://jobs.example.test/1" });
    const second = await add("anni", { jobUrl: "https://jobs.example.test/2" });
    as("anni");
    const r = await putJob(req("PUT", body({ jobUrl: "https://www.jobs.example.test/1/" })), ctx(second));
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("duplicate_url");
  });

  it("maps data-service failures to safe errors", async () => {
    const id = await add("anni");
    as("anni");
    sheets.failAll = googleError(403, "forbidden");
    resetMembersCache();
    const r = await putJob(req("PUT", body()), ctx(id));
    expect(r.status).toBe(502);
    expect(JSON.stringify(await r.json())).not.toContain("SECRET-DETAIL");
  });
});

describe("DELETE /api/jobs/[jobId]", () => {
  it("requires a session", async () => {
    const id = await add("anni");
    as(null);
    expect((await deleteJobRoute(req("DELETE"), ctx(id))).status).toBe(401);
    expect(sheets.dataRows("Jobs")).toHaveLength(1);
  });

  it("lets the owner delete: the job disappears for everyone and application rows go with it", async () => {
    const id = await add("anni");
    for (const who of ["anni", "lukky", "rishii"] as const) {
      as(who);
      expect((await putApp(req("PUT", { status: "Applied" }), ctx(id))).status).toBe(200);
    }
    as("anni");
    const r = await deleteJobRoute(req("DELETE"), ctx(id));
    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual({ jobId: id });
    expect(sheets.dataRows("Jobs")).toHaveLength(0);
    expect(sheets.dataRows("Applications")).toHaveLength(0);
    for (const who of ["anni", "lukky", "rishii"] as const) {
      as(who);
      expect((await (await listJobs(req("GET"))).json()).data).toEqual([]);
    }
  });

  it("returns 403 to non-owners and 404 for unknown jobs; nothing is deleted", async () => {
    const id = await add("anni");
    for (const who of ["lukky", "rishii"] as const) {
      as(who);
      const r = await deleteJobRoute(req("DELETE"), ctx(id));
      expect(r.status).toBe(403);
    }
    as("anni");
    expect((await deleteJobRoute(req("DELETE"), ctx("job_missing"))).status).toBe(404);
    expect((await deleteJobRoute(req("DELETE"), ctx("../x"))).status).toBe(400);
    expect((await deleteJobRoute(req("DELETE", undefined, { origin: "http://evil.example" }), ctx(id))).status).toBe(403);
    expect(sheets.dataRows("Jobs")).toHaveLength(1);
  });

  it("a second delete of the same job is a clean 404", async () => {
    const id = await add("anni");
    as("anni");
    expect((await deleteJobRoute(req("DELETE"), ctx(id))).status).toBe(200);
    expect((await deleteJobRoute(req("DELETE"), ctx(id))).status).toBe(404);
  });
});
