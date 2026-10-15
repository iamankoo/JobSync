import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { GET as listRoute, POST as createRoute } from "@/app/api/connections/route";
import { DELETE as deleteRoute, PUT as updateRoute } from "@/app/api/connections/[connectionId]/route";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import type { MemberId } from "@/config/members";
import { FakeSheets } from "../helpers/fake-sheets";

let sheets: FakeSheets;
const as = (m: MemberId | null) => vi.mocked(getSession).mockResolvedValue(m ? { memberId: m, expiresAt: 9_999_999_999 } : null);
const req = (method: string, data?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/connections", {
    method,
    headers: { "content-type": "application/json", host: "localhost", ...headers },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
const ctx = (connectionId: string) => ({ params: Promise.resolve({ connectionId }) });
const person = (over: Record<string, unknown> = {}) => ({
  name: "Priya Sharma", company: "Acme Corp", role: "Engineering Manager", profileUrl: "https://www.linkedin.com/in/priya-test",
  message: "Hi Priya,\nI'd love to connect.", notes: "Met at a meetup", ...over,
});

async function add(m: MemberId, over: Record<string, unknown> = {}) {
  as(m);
  const res = await createRoute(req("POST", person(over)));
  expect(res.status).toBe(201);
  return (await res.json()).data as { connectionId: string; status: string };
}
async function list(m: MemberId) {
  as(m);
  return (await (await listRoute(req("GET"))).json()).data as { connectionId: string; name: string; status: string; message?: string }[];
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

describe("Connections API", () => {
  it("requires a session and rejects cross-origin writes", async () => {
    as(null);
    expect((await listRoute(req("GET"))).status).toBe(401);
    expect((await createRoute(req("POST", person()))).status).toBe(401);
    as("anni");
    expect((await createRoute(req("POST", person(), { origin: "https://evil.example" }))).status).toBe(403);
    expect(sheets.dataRows("Connections")).toHaveLength(0);
  });

  it("creates a connection owned by the SESSION member, with status Not Connected by default", async () => {
    const c = await add("lukky");
    expect(c.status).toBe("Not Connected");
    const row = sheets.dataRows("Connections")[0];
    expect(row[1]).toBe("lukky");
    expect(row[2]).toBe("Priya Sharma");
    expect(row[7]).toContain("I'd love to connect.");
  });

  it("never lets the body choose the owner", async () => {
    as("anni");
    const res = await createRoute(req("POST", person({ memberId: "lukky" })));
    expect(res.status).toBe(400);
  });

  it("validates input: name required, URLs must be http(s), lengths bounded", async () => {
    as("anni");
    for (const bad of [{ name: "" }, { name: "  " }, { profileUrl: "javascript:alert(1)" }, { otherUrl: "ftp://x.example.com/a" }, { message: "x".repeat(2001) }, { status: "Ghosted" }]) {
      const res = await createRoute(req("POST", person(bad)));
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(sheets.dataRows("Connections")).toHaveLength(0);
  });

  it("stores spreadsheet-looking text as literal text", async () => {
    await add("anni", { name: "=HYPERLINK(\"http://x\")", message: "=1+1" });
    expect(sheets.dataRows("Connections")[0][2]).toBe("=HYPERLINK(\"http://x\")");
  });

  it("the list is SHARED: whoever adds one, all three members see the same entries, with who added it and when", async () => {
    for (const adder of ["anni", "lukky", "rishii"] as MemberId[]) await add(adder, { name: `${adder}'s contact`, company: "Shared Co" });
    for (const viewer of ["anni", "lukky", "rishii"] as MemberId[]) {
      const rows = (await list(viewer)) as unknown as { name: string; memberId: string; createdAt: string; status: string; message?: string }[];
      expect(rows.map((c) => c.name).sort(), viewer).toEqual(["anni's contact", "lukky's contact", "rishii's contact"]);
      expect(rows.every((c) => c.memberId && !Number.isNaN(Date.parse(c.createdAt)) && c.message?.includes("love to connect"))).toBe(true);
      // identical data for everyone, and search-style filtering over it is therefore consistent
      expect(rows.filter((c) => c.name.includes("lukky")).map((c) => c.memberId)).toEqual(["lukky"]);
    }
    expect((await list("anni")).map((c) => c.connectionId).sort()).toEqual((await list("rishii")).map((c) => c.connectionId).sort());
  });

  it("updates the status through every required value and persists it", async () => {
    const { connectionId } = await add("anni");
    for (const status of ["Connected", "Messaged", "Reply", "Not Connected"]) {
      as("anni");
      const res = await updateRoute(req("PUT", { status }), ctx(connectionId));
      expect(res.status).toBe(200);
      expect((await res.json()).data.status).toBe(status);
      expect((await list("anni"))[0].status).toBe(status);
    }
  });

  it("edits fields, keeps untouched ones, and clears an optional field with an empty value", async () => {
    const { connectionId } = await add("anni");
    as("anni");
    const res = await updateRoute(req("PUT", { company: "New Co", notes: "" }), ctx(connectionId));
    expect(res.status).toBe(200);
    const [c] = (await list("anni")) as unknown as { company?: string; notes?: string; message?: string; name: string }[];
    expect(c).toMatchObject({ name: "Priya Sharma", company: "New Co" });
    expect(c.notes).toBeUndefined();
    expect(c.message).toContain("love to connect");
  });

  it("rejects an empty update", async () => {
    const { connectionId } = await add("anni");
    as("anni");
    expect((await updateRoute(req("PUT", {}), ctx(connectionId))).status).toBe(400);
  });

  it("others can see an entry but get 403 when they try to edit or delete it; unknown IDs are 404", async () => {
    const { connectionId } = await add("anni");
    for (const m of ["lukky", "rishii"] as MemberId[]) {
      as(m);
      expect((await updateRoute(req("PUT", { status: "Reply" }), ctx(connectionId))).status).toBe(403);
      expect((await deleteRoute(req("DELETE"), ctx(connectionId))).status).toBe(403);
      expect((await list(m))).toHaveLength(1);
    }
    as("lukky");
    expect((await updateRoute(req("PUT", { status: "Reply" }), ctx("conn_missing"))).status).toBe(404);
    expect((await list("anni"))[0].status).toBe("Not Connected");
  });

  it("deletes the owner's connection only", async () => {
    const a = await add("anni");
    await add("anni", { name: "Keep me" });
    as("anni");
    expect((await deleteRoute(req("DELETE"), ctx(a.connectionId))).status).toBe(200);
    expect((await list("anni")).map((c) => c.name)).toEqual(["Keep me"]);
  });

  it("reports a clear 503 (not a crash) while the Connections tab does not exist", async () => {
    sheets.tabs.delete("Connections");
    as("anni");
    const res = await listRoute(req("GET"));
    expect(res.status).toBe(503);
  });

  it("does not touch Jobs, Applications, Members or Activity", async () => {
    await add("anni");
    for (const tab of ["Jobs", "Applications", "Activity"]) expect(sheets.dataRows(tab)).toHaveLength(0);
    expect(sheets.dataRows("Members")).toHaveLength(3);
  });
});
