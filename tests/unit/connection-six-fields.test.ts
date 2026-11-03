import { describe, expect, it } from "vitest";
import { applyRoleProblem, ROLE_CATEGORIES, ROLE_OPTIONS, rolesFor, suggestApplyRole } from "@/lib/connections/apply-role";
import { createConnectionSchema, createManualConnectionSchema, updateConnectionSchema } from "@/lib/validation/connections";
import { normalizeCompanyUrl } from "@/lib/utils/url";
import { normalizePdfName } from "@/lib/profile/rename";
import { parseConnectionRow, serializeConnection } from "@/lib/google-sheets/rows";
import { roleForManual } from "@/lib/network-finder/connection-role";

const VALID = { name: "Priya Sharma", email: "priya@acme.example", company: "Acme Corp", roleCategory: "SDE", applyRole: "Software Engineer" };

describe("Role to Apply options", () => {
  it("has exactly the five categories in order", () => {
    expect([...ROLE_CATEGORIES]).toEqual(["SDE", "AI/ML", "Web D", "Data", "Other"]);
  });
  it("offers exactly the specified roles for each category; Other has no list (custom role)", () => {
    expect([...rolesFor("SDE")]).toEqual(["Software Engineer", "Software Developer", "Backend Engineer"]);
    expect([...rolesFor("AI/ML")]).toEqual(["AI/ML Engineer", "Applied AI Engineer", "Agentic AI Engineer", "AI Engineer", "Machine Learning Engineer", "Python Developer"]);
    expect([...rolesFor("Web D")]).toEqual(["Full Stack Engineer", "Front End Developer", "Web Developer", "App Developer"]);
    expect([...rolesFor("Data")]).toEqual(["Data Engineer", "Data Analyst", "Data Scientist", "Data Entry"]);
    expect(rolesFor("Other")).toEqual([]);
    expect(rolesFor("")).toEqual([]);
  });
  it("accepts every listed pair and nothing else", () => {
    for (const [cat, roles] of Object.entries(ROLE_OPTIONS)) for (const r of roles) expect(applyRoleProblem(cat, r)).toBeNull();
    expect(applyRoleProblem("SDE", "Data Engineer")).toMatch(/list/); // a role from another category
    expect(applyRoleProblem("SDE", "Made Up Role")).toMatch(/list/);
    expect(applyRoleProblem("", "Software Engineer")).toMatch(/category/);
    expect(applyRoleProblem("Nope", "x")).toMatch(/category/);
    expect(applyRoleProblem("SDE", "")).toMatch(/role/i);
    expect(applyRoleProblem(undefined, undefined)).toMatch(/category/);
  });
  it("Other needs a custom role (2-80 chars, no control characters)", () => {
    expect(applyRoleProblem("Other", "")).toMatch(/Enter the role/);
    expect(applyRoleProblem("Other", "  ")).toMatch(/Enter the role/);
    expect(applyRoleProblem("Other", "a")).toMatch(/at least/);
    expect(applyRoleProblem("Other", "x".repeat(81))).toMatch(/Max/);
    expect(applyRoleProblem("Other", "Site Reliability Engineer")).toBeNull();
    expect(applyRoleProblem("Other", "Bad\u0007role")).toMatch(/Invalid/);
  });
  it("suggests (never saves) a role for a historical record: a listed role keeps its category, anything else is Other", () => {
    expect(suggestApplyRole("machine learning engineer")).toEqual({ category: "AI/ML", role: "Machine Learning Engineer" });
    expect(suggestApplyRole("Full Stack Developer Intern")).toEqual({ category: "Other", role: "Full Stack Developer Intern" });
    expect(suggestApplyRole("")).toBeNull();
    expect(suggestApplyRole(undefined)).toBeNull();
  });
});

describe("Company URL normalisation", () => {
  it("adds https when the scheme is missing, drops the fragment, keeps the path, never invents a URL", () => {
    expect(normalizeCompanyUrl("acme.com")).toBe("https://acme.com/");
    expect(normalizeCompanyUrl("  https://www.acme.com/about#team ")).toBe("https://www.acme.com/about");
    expect(normalizeCompanyUrl("http://acme.com")).toBe("http://acme.com/");
    expect(normalizeCompanyUrl("")).toBeNull();
    expect(normalizeCompanyUrl("   ")).toBeNull();
  });
  it("rejects anything that is not a public website (other schemes, credentials, IPs, localhost, internal names)", () => {
    for (const bad of ["javascript:alert(1)", "ftp://acme.com", "https://user:pw@acme.com", "http://127.0.0.1/", "http://192.168.1.5", "http://localhost:3000", "https://intranet.corp", "https://acme", "not a url", "file:///etc/passwd", "https://metadata.internal/"]) {
      expect(normalizeCompanyUrl(bad), bad).toBeNull();
    }
  });
});

describe("Add (createManualConnectionSchema): Person Name, Person Email, Company Name and Role to Apply are required", () => {
  it("accepts the minimum, with Person Designation and Company URL left empty", () => {
    const r = createManualConnectionSchema.parse({ ...VALID, role: "", companyUrl: "" });
    expect(r).toMatchObject({ name: "Priya Sharma", company: "Acme Corp", applyRole: "Software Engineer", roleCategory: "SDE", status: "Not Connected" });
    expect(r.role).toBeUndefined();
    expect(r.companyUrl).toBeUndefined();
  });
  it("normalises a supplied Company URL", () => {
    expect(createManualConnectionSchema.parse({ ...VALID, companyUrl: "acme.com" }).companyUrl).toBe("https://acme.com/");
  });
  it("names the field for each missing required value", () => {
    const issues = (b: object) => createManualConnectionSchema.safeParse(b).error?.issues.map((i) => i.path.join(".")) ?? [];
    expect(issues({})).toEqual(expect.arrayContaining(["name", "email", "company", "roleCategory"]));
    expect(issues({ ...VALID, email: "" })).toEqual(["email"]);
    expect(issues({ ...VALID, company: " " })).toEqual(["company"]);
    expect(issues({ ...VALID, name: "" })).toEqual(["name"]);
    expect(issues({ ...VALID, roleCategory: "", applyRole: "" })).toEqual(["roleCategory"]);
    expect(issues({ ...VALID, applyRole: "" })).toEqual(["applyRole"]);
    expect(issues({ ...VALID, roleCategory: "Other", applyRole: "" })).toEqual(["applyRole"]);
    expect(issues({ ...VALID, roleCategory: "Data" })).toEqual(["applyRole"]); // Software Engineer is not a Data role
    expect(issues({ ...VALID, companyUrl: "javascript:alert(1)" })).toEqual(["companyUrl"]);
    expect(issues({ ...VALID, email: "nope" })).toEqual(["email"]);
  });
  it("still accepts the historical keys from old payloads, and rejects unknown ones", () => {
    const r = createManualConnectionSchema.parse({ ...VALID, profileUrl: "https://linkedin.com/in/x", otherUrl: "https://x.dev", message: "hi", notes: "n" });
    expect(r).toMatchObject({ profileUrl: "https://linkedin.com/in/x", message: "hi", notes: "n" });
    expect(createManualConnectionSchema.safeParse({ ...VALID, memberId: "lukky" }).success).toBe(false);
    expect(createManualConnectionSchema.safeParse({ ...VALID, isAdmin: true }).success).toBe(false);
  });
  it("the permissive schema (Network Finder / server callers) still needs only a name", () => {
    expect(createConnectionSchema.parse({ name: "X" })).toMatchObject({ name: "X", status: "Not Connected" });
  });
});

describe("Edit (updateConnectionSchema)", () => {
  it("a partial update (status, or one field) stays valid", () => {
    expect(updateConnectionSchema.parse({ status: "Messaged" })).toEqual({ status: "Messaged" });
    expect(updateConnectionSchema.parse({ role: "" })).toHaveProperty("role", undefined);
    expect(updateConnectionSchema.parse({ companyUrl: "" })).toHaveProperty("companyUrl", undefined); // clearing the optional URL
  });
  it("required fields cannot be cleared, and the role is always saved as a valid pair", () => {
    for (const body of [{ email: "" }, { company: "" }, { roleCategory: "" , applyRole: "" }, { roleCategory: "SDE" }, { applyRole: "Software Engineer" }, { roleCategory: "SDE", applyRole: "Data Analyst" }, { roleCategory: "Other", applyRole: "" }]) {
      expect(updateConnectionSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
    expect(updateConnectionSchema.safeParse({ roleCategory: "Other", applyRole: "SRE Lead" }).success).toBe(true);
  });
});

describe("sheet rows stay compatible", () => {
  const base = ["conn_1", "anni", "Priya", "Acme", "Recruiter", "https://linkedin.com/in/p", "https://p.dev", "old message", "Role: Data Engineer", "Reply", "2026-10-01T10:00:00.000Z", "2026-10-02T10:00:00.000Z"];
  it("a 12-column (or 13-column) historical row loads with every old value intact and no new fields", () => {
    for (const row of [base, [...base, "p@acme.example"]]) {
      const r = parseConnectionRow(row);
      expect(r.ok && r.value).toMatchObject({ name: "Priya", role: "Recruiter", profileUrl: "https://linkedin.com/in/p", otherUrl: "https://p.dev", message: "old message", notes: "Role: Data Engineer", status: "Reply" });
      expect(r.ok && r.value.companyUrl).toBeUndefined();
      expect(r.ok && r.value.applyRole).toBeUndefined();
    }
  });
  it("new values are appended after Email and an unchanged round trip keeps the historical columns byte for byte", () => {
    const r = parseConnectionRow([...base, "p@acme.example", "https://acme.com/", "AI/ML", "Machine Learning Engineer"]);
    if (!r.ok) throw new Error("row");
    expect(r.value).toMatchObject({ companyUrl: "https://acme.com/", roleCategory: "AI/ML", applyRole: "Machine Learning Engineer", role: "Recruiter" });
    const out = serializeConnection(r.value);
    expect(out.slice(0, 12)).toEqual(base);
    expect(out.slice(12)).toEqual(["p@acme.example", "https://acme.com/", "AI/ML", "Machine Learning Engineer"]);
  });
  it("a malformed Company URL cell is ignored with a warning instead of breaking the row", () => {
    const r = parseConnectionRow([...base, "", "not a url", "", ""]);
    expect(r.ok).toBe(true);
    expect(r.ok && r.warnings.join()).toMatch(/CompanyUrl/);
  });
});

describe("the selected role is authoritative for research and drafts", () => {
  it("applyRole beats anything in the old free-text notes", () => {
    expect(roleForManual({ applyRole: "Backend Engineer", notes: "Role: Data Engineer" })).toEqual({ status: "found", role: { title: "Backend Engineer", internship: false } });
  });
  it("a historical record without one falls back to its notes", () => {
    expect(roleForManual({ notes: "Role: Data Engineer" })).toMatchObject({ status: "found", role: { title: "Data Engineer" } });
    expect(roleForManual({}).status).toBe("missing");
  });
});

describe("PDF file name rules", () => {
  it("trims, keeps the extension and never doubles it", () => {
    expect(normalizePdfName("  My Resume  ")).toEqual({ ok: true, fileName: "My Resume.pdf" });
    expect(normalizePdfName("My Resume.PDF")).toEqual({ ok: true, fileName: "My Resume.pdf" });
    expect(normalizePdfName("a.b.c")).toEqual({ ok: true, fileName: "a.b.c.pdf" });
  });
  it("rejects empty, invalid, reserved and over-long names with a message", () => {
    for (const bad of ["", "  ", ".pdf", "...", "a/b", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b", "a\u0000b", "name.", "con", "NUL", "x".repeat(97)]) {
      const r = normalizePdfName(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      if (!r.ok) expect(r.message.length).toBeGreaterThan(5);
    }
    expect(normalizePdfName("x".repeat(96)).ok).toBe(true);
  });
});
