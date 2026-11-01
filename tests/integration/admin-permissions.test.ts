/**
 * Anni is the administrator: she may edit and delete ANY job and connection; Lukky and Rishii only their own. Every case goes
 * through the real route handlers with a mocked SESSION (the only source of identity) over the in-memory spreadsheet, i.e. the
 * same code a direct API call reaches. Nothing real is touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { POST as createJobRoute } from "@/app/api/jobs/route";
import { DELETE as deleteJobRoute, PUT as updateJobRoute } from "@/app/api/jobs/[jobId]/route";
import { POST as createConnRoute, GET as listConnRoute } from "@/app/api/connections/route";
import { DELETE as deleteConnRoute, PUT as updateConnRoute } from "@/app/api/connections/[connectionId]/route";
import { isAdmin, MEMBER_IDS, type MemberId } from "@/config/members";
import { setApplicationStatus } from "@/lib/google-sheets/applications-service";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { FakeSheets } from "../helpers/fake-sheets";

let sheets: FakeSheets;
const as = (m: MemberId | null) => vi.mocked(getSession).mockResolvedValue(m ? { memberId: m, expiresAt: 9_999_999_999 } : null);
const json = (method: string, data?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/x", { method, headers: { "content-type": "application/json", host: "localhost", ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
const jobCtx = (jobId: string) => ({ params: Promise.resolve({ jobId }) });
const connCtx = (connectionId: string) => ({ params: Promise.resolve({ connectionId }) });

const jobBody = (n: number, over: Record<string, unknown> = {}) => ({
  company: `Synthetic Co ${n}`, jobRole: `Test Role ${n}`, jobType: "Full-time", location: "Testville", jobUrl: `https://jobs.example.test/${n}`, ...over,
});
async function addJob(m: MemberId, n: number) {
  as(m);
  const res = await createJobRoute(json("POST", jobBody(n)));
  expect(res.status).toBe(201);
  return (await res.json()).data as { jobId: string };
}
async function addConn(m: MemberId, name: string) {
  as(m);
  const res = await createConnRoute(json("POST", { name, company: "Acme", role: "Recruiter", email: `${name.toLowerCase().replace(/\W/g, "")}@acme.example`, notes: "Role: Backend Engineer" }));
  expect(res.status).toBe(201);
  return (await res.json()).data as { connectionId: string };
}
const jobIds = () => sheets.dataRows("Jobs").map((r) => r[0]);
const activity = () => sheets.dataRows("Activity").map((r) => ({ member: r[1], action: r[3], id: r[4] }));
const adminRows = () => activity().filter((a) => a.action.startsWith("admin_"));
const edit = (m: MemberId, jobId: string, over: Record<string, unknown> = {}) => { as(m); return updateJobRoute(json("PUT", jobBody(99, { company: "Edited Co", ...over })), jobCtx(jobId)); };
const remove = (m: MemberId, jobId: string) => { as(m); return deleteJobRoute(json("DELETE"), jobCtx(jobId)); };

beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
});
afterEach(() => {
  setSheetsClientForTesting(null);
  vi.mocked(getSession).mockReset();
});

describe("who is the administrator", () => {
  it("is Anni only", () => {
    expect(MEMBER_IDS.filter(isAdmin)).toEqual(["anni"]);
    expect(isAdmin("Anni")).toBe(false);
    expect(isAdmin(undefined)).toBe(false);
  });
});

describe("jobs: the administrator may edit and delete ANY job", () => {
  for (const owner of ["lukky", "rishii"] as const) {
    it(`Anni edits a job added by ${owner}: it changes, AddedBy stays ${owner}, and an admin audit row is written`, async () => {
      const j = await addJob(owner, 1);
      const before = sheets.dataRows("Jobs")[0];
      const res = await edit("anni", j.jobId, { jobRole: "Corrected Role", jobUrl: "https://jobs.example.test/1" });
      expect(res.status).toBe(200);
      const row = sheets.dataRows("Jobs")[0];
      expect(row[0]).toBe(j.jobId);
      expect(row[2]).toBe("Corrected Role");
      expect(row[11]).toBe(owner); // original attribution preserved
      expect(row[12]).toBe(before[12]); // AddedAt too
      expect(adminRows()).toEqual([{ member: "anni", action: "admin_edit", id: j.jobId }]); // actor, action, record id
      expect(activity().filter((a) => a.action === "job_updated")).toHaveLength(0);
    });

    it(`Anni deletes a job added by ${owner}: only that job and its own application rows go; the audit row keeps the id`, async () => {
      const gone = await addJob(owner, 1);
      const keep = await addJob(owner === "lukky" ? "rishii" : "lukky", 2);
      await setApplicationStatus(owner, gone.jobId, { status: "Applied" });
      await setApplicationStatus("anni", gone.jobId, { status: "Applied" });
      await setApplicationStatus("anni", keep.jobId, { status: "Applied" }); // another job: must survive
      const res = await remove("anni", gone.jobId);
      expect(res.status).toBe(200);
      expect(jobIds()).toEqual([keep.jobId]);
      const apps = sheets.dataRows("Applications");
      expect(apps.map((a) => a[0])).toEqual([keep.jobId]); // existing rule: the deleted job's applications go, nobody else's
      expect(adminRows()).toEqual([{ member: "anni", action: "admin_delete", id: gone.jobId }]);
      expect(activity().filter((a) => a.id === gone.jobId && a.action !== "admin_delete")).toHaveLength(0); // history scrubbed as before
    });
  }

  it("ordinary members still edit and delete their OWN jobs", async () => {
    const l = await addJob("lukky", 1);
    const r = await addJob("rishii", 2);
    expect((await edit("lukky", l.jobId, { jobUrl: "https://jobs.example.test/1" })).status).toBe(200);
    expect((await remove("rishii", r.jobId)).status).toBe(200);
    expect(jobIds()).toEqual([l.jobId]);
    expect(adminRows()).toHaveLength(0); // not admin actions
    expect(activity().filter((a) => a.action === "job_updated" || a.action === "job_deleted").map((a) => a.member).sort()).toEqual(["lukky", "rishii"]);
  });

  it("Anni editing her OWN job is an ordinary edit, not an admin action", async () => {
    const a = await addJob("anni", 1);
    expect((await edit("anni", a.jobId, { jobUrl: "https://jobs.example.test/1" })).status).toBe(200);
    expect(adminRows()).toHaveLength(0);
    expect(activity().some((x) => x.action === "job_updated")).toBe(true);
  });
});

describe("jobs: ordinary members can NOT touch other members' jobs (direct API calls)", () => {
  const cases: [MemberId, MemberId][] = [["lukky", "rishii"], ["lukky", "anni"], ["rishii", "anni"], ["rishii", "lukky"]];
  for (const [actor, owner] of cases) {
    it(`${actor} cannot edit or delete ${owner}'s job (403) and nothing changes`, async () => {
      const j = await addJob(owner, 1);
      const snapshot = JSON.stringify([sheets.rows("Jobs"), sheets.rows("Activity"), sheets.rows("Applications")]);
      const e = await edit(actor, j.jobId, { jobUrl: "https://jobs.example.test/1" });
      expect(e.status).toBe(403);
      expect((await e.json()).error.code).toBe("not_job_owner");
      expect((await remove(actor, j.jobId)).status).toBe(403);
      expect(JSON.stringify([sheets.rows("Jobs"), sheets.rows("Activity"), sheets.rows("Applications")])).toBe(snapshot);
    });
  }

  it("a client-supplied member id or admin flag is never trusted", async () => {
    const j = await addJob("rishii", 1);
    const snapshot = JSON.stringify(sheets.rows("Jobs"));
    as("lukky");
    for (const extra of [{ memberId: "anni" }, { isAdmin: true }, { addedBy: "lukky" }, { role: "admin" }]) {
      const res = await updateJobRoute(json("PUT", { ...jobBody(1), ...extra }, { "x-member-id": "anni", "x-admin": "true", authorization: "Bearer anni" }), jobCtx(j.jobId));
      expect([400, 403], JSON.stringify(extra)).toContain(res.status);
    }
    const del = await deleteJobRoute(json("DELETE", undefined, { "x-member-id": "anni", "x-admin": "true" }), jobCtx(j.jobId));
    expect(del.status).toBe(403);
    expect(JSON.stringify(sheets.rows("Jobs"))).toBe(snapshot);
  });

  it("no session → 401; cross-origin → 403; unknown job → 404 (also for the administrator)", async () => {
    const j = await addJob("lukky", 1);
    as(null);
    expect((await updateJobRoute(json("PUT", jobBody(1)), jobCtx(j.jobId))).status).toBe(401);
    expect((await deleteJobRoute(json("DELETE"), jobCtx(j.jobId))).status).toBe(401);
    as("anni");
    expect((await deleteJobRoute(json("DELETE", undefined, { origin: "https://evil.example" }), jobCtx(j.jobId))).status).toBe(403);
    expect((await deleteJobRoute(json("DELETE"), jobCtx("job_missing"))).status).toBe(404);
    expect(jobIds()).toEqual([j.jobId]);
  });

  it("the administrator must be an ACTIVE member in the Members record: an inactive Anni has no admin rights", async () => {
    setSheetsClientForTesting(null);
    sheets = new FakeSheets().seedMembers({ anni: false });
    setSheetsClientForTesting(sheets);
    resetMembersCache();
    const j = await addJob("lukky", 1);
    const res = await remove("anni", j.jobId);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("member_inactive");
    expect(jobIds()).toEqual([j.jobId]);
  });
});

describe("connections: the administrator may edit and delete ANY connection", () => {
  for (const owner of ["lukky", "rishii"] as const) {
    it(`Anni edits a connection added by ${owner}: owner and id are preserved and an admin audit row is written`, async () => {
      const c = await addConn(owner, "Priya Nair");
      as("anni");
      const res = await updateConnRoute(json("PUT", { company: "Magic Hour AI", notes: "Role: Machine Learning Engineer", status: "Messaged" }), connCtx(c.connectionId));
      expect(res.status).toBe(200);
      const data = (await res.json()).data;
      expect(data).toMatchObject({ connectionId: c.connectionId, memberId: owner, company: "Magic Hour AI", status: "Messaged" });
      as("rishii");
      const list = (await (await listConnRoute(json("GET"))).json()).data as { connectionId: string; memberId: string }[];
      expect(list).toHaveLength(1); // edited in place: no second connection
      expect(list[0]).toMatchObject({ connectionId: c.connectionId, memberId: owner });
      expect(adminRows()).toEqual([{ member: "anni", action: "admin_edit", id: c.connectionId }]);
    });

    it(`Anni deletes a connection added by ${owner}; unrelated connections stay and the audit row keeps the id`, async () => {
      const gone = await addConn(owner, "Gone Person");
      const keep = await addConn(owner === "lukky" ? "rishii" : "lukky", "Keep Person");
      as("anni");
      expect((await deleteConnRoute(json("DELETE"), connCtx(gone.connectionId))).status).toBe(200);
      expect(sheets.dataRows("Connections").map((r) => r[0])).toEqual([keep.connectionId]);
      expect(adminRows()).toEqual([{ member: "anni", action: "admin_delete", id: gone.connectionId }]);
    });
  }

  const cases: [MemberId, MemberId][] = [["lukky", "rishii"], ["lukky", "anni"], ["rishii", "anni"], ["rishii", "lukky"]];
  for (const [actor, owner] of cases) {
    it(`${actor} cannot edit or delete ${owner}'s connection (403) and nothing changes`, async () => {
      const c = await addConn(owner, "Protected Person");
      const snapshot = JSON.stringify([sheets.rows("Connections"), sheets.rows("Activity")]);
      as(actor);
      expect((await updateConnRoute(json("PUT", { company: "Hijacked" }), connCtx(c.connectionId))).status).toBe(403);
      expect((await deleteConnRoute(json("DELETE"), connCtx(c.connectionId))).status).toBe(403);
      expect(JSON.stringify([sheets.rows("Connections"), sheets.rows("Activity")])).toBe(snapshot);
    });
  }

  it("ordinary members still edit and delete their own; a body cannot change the owner or claim admin", async () => {
    const l = await addConn("lukky", "Own Person");
    as("lukky");
    for (const extra of [{ memberId: "anni" }, { isAdmin: true }]) {
      const res = await updateConnRoute(json("PUT", { company: "Own Co", ...extra }, { "x-member-id": "anni" }), connCtx(l.connectionId));
      if (res.status === 200) expect((await res.json()).data.memberId).toBe("lukky");
      else expect(res.status).toBe(400);
    }
    expect((await updateConnRoute(json("PUT", { company: "Own Co" }), connCtx(l.connectionId))).status).toBe(200);
    expect((await deleteConnRoute(json("DELETE"), connCtx(l.connectionId))).status).toBe(200);
    expect(sheets.dataRows("Connections")).toHaveLength(0);
    expect(adminRows()).toHaveLength(0);
  });

  it("no session → 401 and the administrator is not special without one", async () => {
    const c = await addConn("lukky", "Needs Session");
    as(null);
    expect((await updateConnRoute(json("PUT", { company: "x" }), connCtx(c.connectionId))).status).toBe(401);
    expect((await deleteConnRoute(json("DELETE"), connCtx(c.connectionId))).status).toBe(401);
    expect(sheets.dataRows("Connections")).toHaveLength(1);
  });
});
