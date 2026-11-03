/** Add / Edit Connection API with the six-field form: persistence, validation and compatibility with historical rows. In-memory sheet only. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { GET as listRoute, POST as createRoute } from "@/app/api/connections/route";
import { PUT as updateRoute } from "@/app/api/connections/[connectionId]/route";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import type { MemberId } from "@/config/members";
import type { Connection } from "@/types/domain";
import { FakeSheets } from "../helpers/fake-sheets";

let sheets: FakeSheets;
const as = (m: MemberId | null) => vi.mocked(getSession).mockResolvedValue(m ? { memberId: m, expiresAt: 9_999_999_999 } : null);
const req = (method: string, data?: unknown) => new Request("http://localhost/api/connections", { method, headers: { "content-type": "application/json", host: "localhost" }, body: data === undefined ? undefined : JSON.stringify(data) });
const ctx = (connectionId: string) => ({ params: Promise.resolve({ connectionId }) });
const FORM = { name: "Priya Sharma", role: "Engineering Manager", email: "priya@acme.example", company: "Acme Corp", companyUrl: "acme.com", roleCategory: "AI/ML", applyRole: "Machine Learning Engineer" };
const HISTORICAL = ["conn_old1", "lukky", "Old Contact", "Globex", "Recruiter", "https://linkedin.com/in/old", "https://old.dev", "Old message", "Role: Data Engineer", "Reply", "2026-10-01T10:00:00.000Z", "2026-10-01T10:00:00.000Z"];

beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
});
afterEach(() => {
  setSheetsClientForTesting(null);
  vi.mocked(getSession).mockReset();
});

describe("Add Connection (six fields)", () => {
  it("saves the six values; category, final role and the normalised Company URL go to their own columns after Email", async () => {
    as("anni");
    const res = await createRoute(req("POST", FORM));
    expect(res.status).toBe(201);
    const c = (await res.json()).data as Connection;
    expect(c).toMatchObject({ name: "Priya Sharma", role: "Engineering Manager", email: "priya@acme.example", company: "Acme Corp", companyUrl: "https://acme.com/", roleCategory: "AI/ML", applyRole: "Machine Learning Engineer", status: "Not Connected" });
    const row = sheets.dataRows("Connections")[0];
    expect(row.slice(2, 5)).toEqual(["Priya Sharma", "Acme Corp", "Engineering Manager"]);
    expect(row.slice(5, 9)).toEqual(["", "", "", ""]); // historical columns are not filled by the new form
    expect(row.slice(12, 16)).toEqual(["priya@acme.example", "https://acme.com/", "AI/ML", "Machine Learning Engineer"]);
    expect(sheets.rows("Connections")[0].slice(12, 16)).toEqual(["Email", "CompanyUrl", "RoleCategory", "ApplyRole"]);
  });

  it("works with Person Designation and Company URL empty and stores no URL (none is invented)", async () => {
    as("anni");
    const res = await createRoute(req("POST", { ...FORM, role: "", companyUrl: "" }));
    expect(res.status).toBe(201);
    const row = sheets.dataRows("Connections")[0];
    expect(row[4]).toBe("");
    expect(row[13]).toBe("");
  });

  it("server-side validation: each missing or invalid value is refused with its field named, and nothing is saved", async () => {
    as("anni");
    const cases: [Record<string, unknown>, string][] = [
      [{ name: "" }, "name"], [{ email: "" }, "email"], [{ email: "nope" }, "email"], [{ company: "" }, "company"],
      [{ roleCategory: "" , applyRole: "" }, "roleCategory"], [{ roleCategory: "Nonsense" }, "roleCategory"],
      [{ applyRole: "" }, "applyRole"], [{ roleCategory: "SDE", applyRole: "Data Engineer" }, "applyRole"],
      [{ roleCategory: "Other", applyRole: "" }, "applyRole"], [{ companyUrl: "javascript:alert(1)" }, "companyUrl"], [{ companyUrl: "http://127.0.0.1/admin" }, "companyUrl"],
    ];
    for (const [over, field] of cases) {
      const res = await createRoute(req("POST", { ...FORM, ...over }));
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect((await res.json()).error.details.fields, JSON.stringify(over)).toHaveProperty(field);
    }
    expect(sheets.dataRows("Connections")).toHaveLength(0);
  });

  it("a client cannot name the owner or admin rights", async () => {
    as("lukky");
    expect((await createRoute(req("POST", { ...FORM, memberId: "anni" }))).status).toBe(400);
    expect((await createRoute(req("POST", { ...FORM, isAdmin: true }))).status).toBe(400);
    const res = await createRoute(req("POST", FORM));
    expect(sheets.dataRows("Connections")[0][1]).toBe("lukky");
    expect(res.status).toBe(201);
  });

  it("old API payloads that still carry the historical keys are accepted when the six fields are present", async () => {
    as("anni");
    const res = await createRoute(req("POST", { ...FORM, profileUrl: "https://linkedin.com/in/p", message: "hi", notes: "n" }));
    expect(res.status).toBe(201);
    expect(sheets.dataRows("Connections")[0].slice(5, 9)).toEqual(["https://linkedin.com/in/p", "", "hi", "n"]);
  });
});

describe("Edit Connection and historical rows", () => {
  it("a historical row (12 columns, role in its notes) loads, is listed, and keeps every old value after an edit of the new fields", async () => {
    sheets.rows("Connections")[0] = sheets.rows("Connections")[0].slice(0, 12); // the production header today
    sheets.rows("Connections").push(HISTORICAL);
    as("lukky");
    const [seen] = (await (await listRoute(req("GET"))).json()).data as Connection[];
    expect(seen).toMatchObject({ connectionId: "conn_old1", name: "Old Contact", role: "Recruiter", message: "Old message", notes: "Role: Data Engineer", status: "Reply" });
    expect(seen.applyRole).toBeUndefined();

    // The Edit form sends only the six values; the historical fields are not in the body.
    const res = await updateRoute(req("PUT", { name: "Old Contact", role: "Recruiter", email: "old@globex.example", company: "Globex", companyUrl: "globex.com", roleCategory: "Data", applyRole: "Data Engineer" }), ctx("conn_old1"));
    expect(res.status).toBe(200);
    const row = sheets.dataRows("Connections")[0];
    expect(row.slice(0, 11)).toEqual(HISTORICAL.slice(0, 11)); // id, owner, name, company, designation, old links, message, notes, status, createdAt untouched
    expect(row.slice(12, 16)).toEqual(["old@globex.example", "https://globex.com/", "Data", "Data Engineer"]);
  });

  it("the role is saved only as a valid pair; the Company URL can be cleared; required values cannot", async () => {
    as("anni");
    const { connectionId } = (await (await createRoute(req("POST", FORM))).json()).data as Connection;
    for (const body of [{ roleCategory: "SDE" }, { applyRole: "Data Analyst" }, { roleCategory: "Web D", applyRole: "Data Analyst" }, { email: "" }, { company: "" }, { name: "" }]) {
      expect((await updateRoute(req("PUT", body), ctx(connectionId))).status, JSON.stringify(body)).toBe(400);
    }
    expect((await updateRoute(req("PUT", { roleCategory: "Other", applyRole: "SRE Lead" }), ctx(connectionId))).status).toBe(200);
    expect((await updateRoute(req("PUT", { companyUrl: "" }), ctx(connectionId))).status).toBe(200);
    const row = sheets.dataRows("Connections")[0];
    expect(row.slice(13, 16)).toEqual(["", "Other", "SRE Lead"]);
    expect((await updateRoute(req("PUT", { status: "Messaged" }), ctx(connectionId))).status).toBe(200); // a status change needs no role
    expect(sheets.dataRows("Connections")[0].slice(14, 16)).toEqual(["Other", "SRE Lead"]);
  });

  it("only the owner (or the administrator) may edit; the owner and id never change", async () => {
    as("lukky");
    const { connectionId } = (await (await createRoute(req("POST", FORM))).json()).data as Connection;
    as("rishii");
    expect((await updateRoute(req("PUT", { company: "Hijack" }), ctx(connectionId))).status).toBe(403);
    as("anni");
    expect((await updateRoute(req("PUT", { company: "Admin Edit" }), ctx(connectionId))).status).toBe(200);
    const row = sheets.dataRows("Connections")[0];
    expect(row[0]).toBe(connectionId);
    expect(row[1]).toBe("lukky");
    expect(row[3]).toBe("Admin Edit");
  });
});
