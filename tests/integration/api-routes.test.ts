import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { GET as listJobs, POST as postJob } from "@/app/api/jobs/route";
import { GET as listApps } from "@/app/api/applications/route";
import { PUT as putApp } from "@/app/api/applications/[jobId]/route";
import { GET as sheetsStatus } from "@/app/api/sheets/status/route";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import type { MemberId } from "@/config/members";
import { FakeSheets, googleError } from "../helpers/fake-sheets";

let sheets: FakeSheets;

const as = (memberId: MemberId | null) =>
  vi.mocked(getSession).mockResolvedValue(memberId ? { memberId, expiresAt: Math.floor(Date.now() / 1000) + 3600 } : null);

const json = (method: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/x", {
    method,
    headers: { "content-type": "application/json", host: "localhost", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const get = () => new Request("http://localhost/api/x", { method: "GET", headers: { host: "localhost" } });
const params = (jobId: string) => ({ params: Promise.resolve({ jobId }) });

const jobBody = (over: Record<string, unknown> = {}) => ({
  company: "Synthetic Co A",
  jobRole: "Test Role",
  jobType: "Internship",
  location: "Testville",
  jobUrl: "https://jobs.example.test/1",
  ...over,
});

async function addJob(member: MemberId, over: Record<string, unknown> = {}): Promise<string> {
  as(member);
  const res = await postJob(json("POST", jobBody(over)));
  expect(res.status).toBe(201);
  return (await res.json()).data.jobId;
}

beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
  as("anni");
});
afterEach(() => {
  setSheetsClientForTesting(null);
  vi.mocked(getSession).mockReset();
});

describe("authentication", () => {
  it("rejects every protected route without a session, before touching Sheets", async () => {
    as(null);
    const res = [
      await listJobs(get()),
      await postJob(json("POST", jobBody())),
      await listApps(get()),
      await putApp(json("PUT", { status: "Applied" }), params("job_x")),
      await sheetsStatus(get()),
    ];
    for (const r of res) {
      expect(r.status).toBe(401);
      expect((await r.json()).error.code).toBe("unauthenticated");
    }
    expect(sheets.calls).toHaveLength(0);
  });

  it("rejects members marked inactive in the Members tab", async () => {
    sheets = new FakeSheets().seedMembers({ lukky: false });
    setSheetsClientForTesting(sheets);
    resetMembersCache();
    as("lukky");
    const r = await postJob(json("POST", jobBody()));
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("member_inactive");
    expect(sheets.dataRows("Jobs")).toHaveLength(0);
  });

  it("rejects cross-origin state-changing requests", async () => {
    const r = await postJob(json("POST", jobBody(), { origin: "http://evil.example" }));
    expect(r.status).toBe(403);
    expect(sheets.dataRows("Jobs")).toHaveLength(0);
  });
});

describe("POST /api/jobs", () => {
  it("creates a job attributed to the SESSION member and returns 201 with no-store", async () => {
    as("rishii");
    const r = await postJob(json("POST", jobBody()));
    expect(r.status).toBe(201);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const { data } = await r.json();
    expect(data.addedBy).toBe("rishii");
    expect(sheets.dataRows("Jobs")[0][11]).toBe("rishii");
  });

  it("rejects a client-supplied identity or server-controlled fields", async () => {
    for (const extra of [{ addedBy: "lukky" }, { memberId: "lukky" }, { jobId: "job_x" }, { addedAt: "2020-01-01T00:00:00Z" }]) {
      const r = await postJob(json("POST", jobBody(extra)));
      expect(r.status).toBe(400);
    }
    expect(sheets.dataRows("Jobs")).toHaveLength(0);
  });

  it("returns field-level validation errors without echoing values", async () => {
    const r = await postJob(json("POST", jobBody({ jobUrl: "javascript:alert('SENTINEL')", deadline: "2026-02-30" })));
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error.code).toBe("validation_failed");
    expect(Object.keys(body.error.details.fields).sort()).toEqual(["deadline", "jobUrl"]);
    expect(JSON.stringify(body)).not.toContain("SENTINEL");
  });

  it("rejects malformed JSON and oversized bodies", async () => {
    expect((await postJob(json("POST", "{not json"))).status).toBe(400);
    const big = await postJob(json("POST", jobBody({ description: "x".repeat(40_000) })));
    expect(big.status).toBe(413);
    expect(sheets.dataRows("Jobs")).toHaveLength(0);
  });

  it("returns 409 for a duplicate URL with the existing job's ID", async () => {
    const first = await addJob("anni");
    as("lukky");
    const r = await postJob(json("POST", jobBody({ jobUrl: "https://www.jobs.example.test/1/?utm_source=x" })));
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.error.code).toBe("duplicate_url");
    expect(body.error.details.existingJobId).toBe(first);
  });
});

describe("GET /api/jobs and /api/applications", () => {
  it("returns shared jobs with only the caller's status", async () => {
    const jobId = await addJob("anni");
    as("anni");
    expect((await putApp(json("PUT", { status: "Applied", notes: "anni-private" }), params(jobId))).status).toBe(200);

    for (const [member, expected] of [["anni", "Applied"], ["lukky", "Not Applied"], ["rishii", "Not Applied"]] as const) {
      as(member);
      const body = await (await listJobs(get())).json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].myStatus).toBe(expected);
      expect(JSON.stringify(body)).not.toContain("anni-private");
    }
  });

  it("GET /api/applications returns only the caller's own records", async () => {
    const jobId = await addJob("anni");
    as("anni");
    await putApp(json("PUT", { status: "Applied" }), params(jobId));
    as("lukky");
    await putApp(json("PUT", { status: "Applied", notes: "lukky-note" }), params(jobId));

    as("lukky");
    const mine = (await (await listApps(get())).json()).data;
    expect(mine).toHaveLength(1);
    expect(mine[0].memberId).toBe("lukky");
    as("rishii");
    expect((await (await listApps(get())).json()).data).toEqual([]);
  });

  it("reports skipped malformed rows without exposing their contents", async () => {
    sheets.rows("Jobs").push(["job_bad", "SENTINEL-CO", "", "x", "", "", "", "", "", "", "", "", ""]);
    const body = await (await listJobs(get())).json();
    expect(body.meta.skippedRows).toBe(1);
    expect(JSON.stringify(body)).not.toContain("SENTINEL-CO");
  });
});

describe("PUT /api/applications/[jobId]", () => {
  it("writes the SESSION member's row regardless of the request", async () => {
    const jobId = await addJob("anni");
    as("lukky");
    const r = await putApp(json("PUT", { status: "Applied" }, { "x-member-id": "anni" }), params(jobId));
    expect(r.status).toBe(200);
    const rows = sheets.dataRows("Applications");
    expect(rows).toHaveLength(1);
    expect(rows[0][1]).toBe("lukky");
  });

  it("rejects any attempt to act as another member via the body", async () => {
    const jobId = await addJob("anni");
    as("lukky");
    for (const body of [{ status: "Applied", memberId: "anni" }, { status: "Applied", MemberID: "anni" }, { status: "Applied", member: "anni" }]) {
      expect((await putApp(json("PUT", body), params(jobId))).status).toBe(400);
    }
    expect(sheets.dataRows("Applications")).toHaveLength(0);
  });

  it("cannot be used to alter another member's record: each PUT affects only the caller", async () => {
    const jobId = await addJob("anni");
    as("anni");
    await putApp(json("PUT", { status: "Applied" }), params(jobId));
    as("lukky");
    await putApp(json("PUT", { status: "Applied" }), params(jobId));
    await putApp(json("PUT", { status: "Rejected" }), params(jobId));
    const byMember = Object.fromEntries(sheets.dataRows("Applications").map((r) => [r[1], r[2]]));
    expect(byMember).toEqual({ anni: "Applied", lukky: "Rejected" });
  });

  it("returns 404 for unknown jobs, 400 for malformed IDs/bodies, 409 for invalid transitions", async () => {
    expect((await putApp(json("PUT", { status: "Applied" }), params("job_missing"))).status).toBe(404);
    expect((await putApp(json("PUT", { status: "Applied" }), params("../../etc"))).status).toBe(400);
    const jobId = await addJob("anni");
    as("anni");
    expect((await putApp(json("PUT", { status: "Hired" }), params(jobId))).status).toBe(400);
    expect((await putApp(json("PUT", {}), params(jobId))).status).toBe(400);
    const bad = await putApp(json("PUT", { status: "Offer" }), params(jobId));
    expect(bad.status).toBe(409);
    expect((await bad.json()).error.code).toBe("invalid_transition");
  });
});

describe("GET /api/sheets/status", () => {
  const env = {
    GOOGLE_SHEETS_SPREADSHEET_ID: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "svc@proj.iam.gserviceaccount.com",
    GOOGLE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nPRIVATE-SENTINEL\\n-----END PRIVATE KEY-----\\n",
  };
  beforeEach(() => Object.assign(process.env, env));
  afterEach(() => {
    for (const k of Object.keys(env)) delete process.env[k];
  });

  it("returns tab health with no credentials", async () => {
    const r = await sheetsStatus(get());
    expect(r.status).toBe(200);
    const text = JSON.stringify(await r.json());
    expect(text).toContain('"ok":true');
    expect(text).not.toContain("PRIVATE-SENTINEL");
    expect(text).not.toContain(env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
    expect(text).not.toContain(env.GOOGLE_SHEETS_SPREADSHEET_ID);
  });
});

describe("error responses are safe and consistent", () => {
  const SECRET = "SECRET-DETAIL-should-not-leak";

  it.each([
    [401, 502, "credentials"],
    [403, 502, "shared"],
    [404, 502, "found"],
    [429, 503, "busy"],
    [500, 502, "unavailable"],
  ])("Google %i becomes HTTP %i with a safe message", async (google, http, hint) => {
    sheets.failAll = googleError(google, google === 403 ? "forbidden" : undefined);
    resetMembersCache();
    // Members check happens first and also fails; both paths must be safe.
    for (const r of [await listJobs(get()), await postJob(json("POST", jobBody()))]) {
      expect(r.status).toBe(http);
      const body = await r.json();
      expect(body.error.code).toBe("data_service_unavailable");
      expect(body.error.message.toLowerCase()).toContain(hint);
      expect(JSON.stringify(body)).not.toContain(SECRET);
      expect(JSON.stringify(body)).not.toMatch(/stack|at .*\(/i);
      if (google === 429) expect(r.headers.get("retry-after")).toBe("5");
    }
  });

  it("returns 503 naming only missing variables when Google is not configured (no mock fallback)", async () => {
    setSheetsClientForTesting(null);
    for (const k of ["GOOGLE_SHEETS_SPREADSHEET_ID", "GOOGLE_SERVICE_ACCOUNT_EMAIL", "GOOGLE_PRIVATE_KEY"]) delete process.env[k];
    resetMembersCache();
    const r = await listJobs(get());
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body.error.message).toContain("GOOGLE_SHEETS_SPREADSHEET_ID");
    expect(body.data).toBeUndefined();
  });

  it("returns 503 when a tab header is wrong, and does not modify the sheet", async () => {
    sheets.rows("Jobs")[0][0] = "ID";
    const before = JSON.stringify(sheets.rows("Jobs"));
    const r = await postJob(json("POST", jobBody()));
    expect(r.status).toBe(503);
    expect(JSON.stringify(sheets.rows("Jobs"))).toBe(before);
  });

  it("maps unexpected exceptions to a generic 500", async () => {
    sheets.getValues = async () => {
      throw new Error(`boom ${SECRET}`);
    };
    resetMembersCache();
    // Non-Google errors are mapped to upstream_error by the client contract; a raw throw from a
    // custom client is still contained by the route wrapper.
    const r = await listJobs(get());
    expect([500, 502]).toContain(r.status);
    expect(JSON.stringify(await r.json())).not.toContain(SECRET);
  });
});
