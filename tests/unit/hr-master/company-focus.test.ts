import { describe, expect, it } from "vitest";
import { classifyCompanyFocus, classifyFromBody, classifyFromName } from "@/lib/hr-master/company-focus";
import { buildCompanyRecords, buildMaster, inferRoleFromCompany } from "@/lib/hr-master/master";
import { dedupe } from "@/lib/hr-master/dedupe";
import { extractDataJson } from "@/lib/hr-master/extract";
import { validateMaster } from "@/lib/hr-master/schema";
import type { CompanyResearch } from "@/lib/hr-master/types";

const res = (over: Partial<CompanyResearch>): CompanyResearch => ({ domain: "acme.com", status: "researched", fetchedAt: "2026-11-04T00:00:00.000Z", finalUrl: "https://acme.com/", finalDomain: "acme.com", sources: ["https://acme.com/"], ...over });

describe("classifyCompanyFocus", () => {
  it("software development / products / services -> Software Engineer", () => {
    expect(classifyCompanyFocus({ title: "Acme - Custom Software Development Company" })?.category).toBe("Software Engineer");
    expect(classifyCompanyFocus({ description: "We build SaaS products for logistics teams" })?.category).toBe("Software Engineer");
  });
  it("AI / ML focus -> AI Engineer, and AI wins when at least as prominent as software", () => {
    expect(classifyCompanyFocus({ title: "Acme | AI-powered customer support", description: "Generative AI agents" })?.category).toBe("AI Engineer");
    expect(classifyCompanyFocus({ title: "Acme", description: "Machine learning and generative AI consultancy" })?.category).toBe("AI Engineer");
    expect(classifyCompanyFocus({ title: "Acme", description: "Machine learning and software development consultancy" })?.category).toBe("Software Engineer");
    expect(classifyCompanyFocus({ title: "Baby Monitor Co", description: "Beautiful AI-powered infant monitors" })).toBeNull();
    expect(classifyCompanyFocus({ title: "Acme software development company, software products and a little machine learning" })?.category).toBe("Software Engineer");
  });
  it("does not guess for non-software businesses or vague 'technology' wording", () => {
    expect(classifyCompanyFocus({ title: "Acme Textiles - cotton exporters" })).toBeNull();
    expect(classifyCompanyFocus({ title: "Acme", description: "Leading technology company" })).toBeNull();
    expect(classifyCompanyFocus({ title: "Acme Digital Marketing Agency", description: "SEO and web development for small business" })).toBeNull();
    expect(classifyCompanyFocus({})).toBeNull();
    expect(inferRoleFromCompany(res({ finalDomain: "wordpress.com", title: "Custom software development company" }), undefined)).toBeNull();
  });
  it("falls back to the About page only when the homepage headline is inconclusive", () => {
    const r = classifyCompanyFocus({ title: "Acme", about: "Acme is a software product company founded in 2012." });
    expect(r).toMatchObject({ category: "Software Engineer", from: "about" });
    expect(classifyCompanyFocus({ title: "Acme AI platform", about: "software development" })?.from).toBe("homepage");
  });
});

describe("company-inferred roles in the master", () => {
  const raw = extractDataJson(JSON.stringify([
    { SNo: 1, Name: "Jane Doe", Email: "jane.doe@acme.com", Title: "HR", Company: "Acme" },
    { SNo: 2, Name: "Raj Kumar", Email: "raj.kumar@fabric.com", Title: "HR", Company: "Fabric" },
  ])).records;
  const d = dedupe(raw);
  const research = new Map([
    ["acme.com", res({ title: "Acme", description: "Application development for retail teams", sources: ["https://acme.com/"] })],
    ["fabric.com", res({ domain: "fabric.com", finalUrl: "https://fabric.com/", finalDomain: "fabric.com", title: "Fabric", description: "Cotton fabrics", sources: ["https://fabric.com/"] })],
  ]);
  const rows = buildMaster(d.contacts, d.groups, buildCompanyRecords(d.contacts, research));
  const by = (e: string) => rows.find((r) => r.PersonEmail === e)!;

  it("labels the classification as company-based inference and keeps the status below Verified", () => {
    const j = by("jane.doe@acme.com");
    expect(j).toMatchObject({ PrimaryRoleCategory: "Software Engineer", RoleBasis: "company-inferred", RoleVerificationStatus: "Partially Verified" });
    expect(j.HiringEvidence).toMatch(/COMPANY-BASED INFERENCE/);
    expect(j.HiringEvidence).toMatch(/not a verified designation/);
  });
  it("unclear companies get the labelled Software Engineer default, still Unverified", () => {
    expect(by("raj.kumar@fabric.com")).toMatchObject({ PrimaryRoleCategory: "Software Engineer", RoleBasis: "default-fallback", RoleVerificationStatus: "Unverified" });
    expect(validateMaster(rows)).toEqual([]);
  });
  it("never overrides a role that already has evidence", () => {
    const withCareers = res({ title: "Acme Software", careersUrl: "https://acme.com/careers", careersTitles: ["Data Analyst"], sources: ["https://acme.com/", "https://acme.com/careers"] });
    const r = buildMaster(d.contacts, d.groups, buildCompanyRecords(d.contacts, new Map([["acme.com", withCareers]])));
    expect(r.find((x) => x.PersonEmail === "jane.doe@acme.com")).toMatchObject({ PrimaryRoleCategory: "Data Analyst", RoleBasis: "careers-listing", RoleVerificationStatus: "Verified" });
  });
  it("uses an About page when provided and adds it to the research sources", () => {
    const about = new Map([["fabric.com", { domain: "fabric.com", url: "https://fabric.com/about", text: "Fabric is an AI-first company building machine learning products.", fetchedAt: "x" }]]);
    const r = buildMaster(d.contacts, d.groups, buildCompanyRecords(d.contacts, research, about)).find((x) => x.PersonEmail === "raj.kumar@fabric.com")!;
    expect(r).toMatchObject({ PrimaryRoleCategory: "Software Engineer" === r.PrimaryRoleCategory ? "Software Engineer" : "AI Engineer", RoleBasis: "company-inferred" });
    expect(r.ResearchSources).toContain("https://fabric.com/about");
  });
  it("is not applied when the site could not be read", () => {
    expect(inferRoleFromCompany(res({ status: "unreachable" }), undefined)).toBeNull();
    expect(inferRoleFromCompany(undefined, undefined)).toBeNull();
  });
});

describe("stricter body / name / default-fallback stages", () => {
  it("classifyFromBody needs three distinct signals and respects sector vetoes", () => {
    const text = "We offer software development, custom software and enterprise software built as SaaS for clients.";
    expect(classifyFromBody({ title: "Acme", textSample: text })?.category).toBe("Software Engineer");
    expect(classifyFromBody({ title: "Acme", textSample: "software development and SaaS" })).toBeNull();
    expect(classifyFromBody({ title: "Acme Bank", textSample: "machine learning, generative ai, computer vision for banking customers" })).toBeNull();
    expect(classifyFromBody({ title: "Acme AI", textSample: "machine learning, generative ai, computer vision for banking" })?.category).toBe("AI Engineer");
  });
  it("classifyFromName reads only explicit field words in the company's own name", () => {
    expect(classifyFromName("Pranathi Software Services Pvt Ltd")?.category).toBe("Software Engineer");
    expect(classifyFromName("Suki AI")?.category).toBe("AI Engineer");
    expect(classifyFromName("Locale.ai")).toBeNull(); // a .ai web suffix is not a statement of business
    expect(classifyFromName("Sai Textiles")).toBeNull();
    expect(classifyFromName("Acme Infotech")).toBeNull();
    expect(classifyFromName("")).toBeNull();
  });
  const raw = extractDataJson(JSON.stringify([
    { SNo: 1, Name: "", Email: "info@nocompany.example.org", Title: "", Company: "" },
    { SNo: 2, Name: "Pat Lee", Email: "pat.lee@gmail.com", Title: "HR", Company: "Zenith Software Pvt Ltd" },
    { SNo: 3, Name: "Sam Roe", Email: "sam.roe@gmail.com", Title: "HR", Company: "Sunrise Textiles" },
    { SNo: 4, Name: "Kim Wu", Email: "kim.wu@gmail.com", Title: "HR", Company: "" },
  ])).records;
  const d = dedupe(raw);
  const rows = buildMaster(d.contacts, d.groups, buildCompanyRecords(d.contacts, new Map()));
  const by = (e: string) => rows.find((r) => r.PersonEmail === e)!;
  it("no company at all -> Software Engineer default-fallback, Unverified, company name left empty (never invented)", () => {
    for (const e of ["info@nocompany.example.org", "kim.wu@gmail.com"]) {
      expect(by(e)).toMatchObject({ PrimaryRoleCategory: "Software Engineer", RoleBasis: "default-fallback", RoleVerificationStatus: "Unverified", CompanyName: "", CompanyReference: "your company" });
      expect(by(e).HiringEvidence).toMatch(/DEFAULT FALLBACK/);
    }
    expect(by("info@nocompany.example.org")).toMatchObject({ PersonName: "", SalutationName: "Hiring Team" });
    expect(by("kim.wu@gmail.com").SalutationName).toBe("Kim Wu");
  });
  it("a named company gets a name-based inference only when its name says so; otherwise the labelled default applies", () => {
    expect(by("pat.lee@gmail.com")).toMatchObject({ PrimaryRoleCategory: "Software Engineer", RoleBasis: "company-inferred", RoleVerificationStatus: "Partially Verified", CompanyReference: "Zenith Software Pvt Ltd" });
    expect(by("sam.roe@gmail.com")).toMatchObject({ PrimaryRoleCategory: "Software Engineer", RoleBasis: "default-fallback", RoleVerificationStatus: "Unverified", CompanyName: "Sunrise Textiles", CompanyReference: "Sunrise Textiles" });
    expect(by("sam.roe@gmail.com").HiringEvidence).toMatch(/other industry, or insufficient information/);
  });
  it("validates, and a default-fallback with a Verified status or another category is rejected", () => {
    expect(validateMaster(rows)).toEqual([]);
    expect(rows.every((r) => r.PrimaryRoleCategory !== "Unverified")).toBe(true);
    expect(validateMaster([{ ...by("kim.wu@gmail.com"), PrimaryRoleCategory: "Data Analyst" }]).length).toBeGreaterThan(0);
    expect(validateMaster([{ ...by("kim.wu@gmail.com"), RoleVerificationStatus: "Verified" }]).length).toBeGreaterThan(0);
  });
});
