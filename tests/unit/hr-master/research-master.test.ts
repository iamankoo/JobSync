import { describe, expect, it } from "vitest";
import { dedupe } from "@/lib/hr-master/dedupe";
import { extractDataJson } from "@/lib/hr-master/extract";
import { buildCompanyRecords, buildMaster } from "@/lib/hr-master/master";
import {
  assessCompany,
  assessRole,
  findCareersUrl,
  jobTitlesIn,
  looksParked,
  parsePage,
  parseResearchJsonl,
  robotsAllows,
  selectPendingDomains,
} from "@/lib/hr-master/research";
import { masterContactSchema, validateMaster } from "@/lib/hr-master/schema";
import { APPROVED_TO_APPLY_ROLE, duplicateKey, importReadiness, mappingProblems, toConnectionDraft } from "@/lib/hr-master/connections-mapping";
import { APPROVED_ROLE_CATEGORIES, MASTER_FIELDS, type CompanyResearch } from "@/lib/hr-master/types";

const NOW = "2026-11-03T10:00:00.000Z";
const research = (over: Partial<CompanyResearch>): CompanyResearch => ({ domain: "acme.com", status: "researched", fetchedAt: NOW, finalUrl: "https://acme.com/", finalDomain: "acme.com", sources: ["https://acme.com/"], ...over });

describe("HTML parsing", () => {
  const html = `<html><head><title>Acme &amp; Co | Software</title><meta name="description" content="We build Python and data products."><meta property="og:site_name" content="Acme"></head>
  <body><nav><a href="/about">About</a><a href="/careers">Careers</a><a href="https://blog.acme.com/post/careers-tips">Careers tips</a></nav><script>var x='<a href=/evil>'</script><p>Hello world, this is a long enough page of body text for the parked check to pass cleanly.</p></body></html>`;
  const p = parsePage(html);
  it("extracts title, description, site name and visible text only", () => {
    expect(p.title).toBe("Acme & Co | Software");
    expect(p.description).toContain("Python");
    expect(p.siteName).toBe("Acme");
    expect(p.text).not.toContain("evil");
  });
  it("finds the careers link on the same site and ignores blog posts", () => {
    expect(findCareersUrl(p, "https://acme.com/")).toBe("https://acme.com/careers");
  });
  it("does not call a JS-rendered site with a title parked, but does call a for-sale page parked", () => {
    expect(looksParked(parsePage("<title>Real Co</title><div id=root></div>"))).toBe(false);
    expect(looksParked(parsePage("<html><body>This domain is for sale. Buy this domain today at hugedomains and more words to pass length</body></html>"))).toBe(true);
    expect(looksParked(parsePage("<html></html>"))).toBe(true);
  });
});

describe("robots.txt", () => {
  it("honours the * group with longest-match precedence", () => {
    expect(robotsAllows("User-agent: *\nDisallow: /", "/")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /\nAllow: /careers", "/careers/x")).toBe(true);
    expect(robotsAllows("User-agent: googlebot\nDisallow: /", "/")).toBe(true);
    expect(robotsAllows("", "/")).toBe(true);
  });
});

describe("role assessment", () => {
  it("Verified only when a matching title is on the careers page", () => {
    const r = assessRole(research({ title: "Acme", careersUrl: "https://acme.com/careers", careersTitles: ["Python Developer", "Data Analyst"], textSample: "" }));
    expect(r.status).toBe("Verified");
    expect(["Python Developer", "Data Analyst"]).toContain(r.primary);
    expect(r.evidence).toContain("https://acme.com/careers");
  });
  it("Partially Verified for business-only evidence, and says no opening is confirmed", () => {
    const r = assessRole(research({ title: "Acme", description: "Machine learning and computer vision products", textSample: "" }));
    expect(r.status).toBe("Partially Verified");
    expect(r.primary).toBe("AI/ML Engineer");
    expect(r.evidence).toMatch(/No specific current opening/);
  });
  it("is Unverified (never guessed) for a company with no relevant evidence, or an unreadable site", () => {
    expect(assessRole(research({ title: "Acme Textiles", description: "Cotton fabrics exporter", textSample: "We export cotton fabrics." }))).toMatchObject({ primary: "Unverified", status: "Unverified" });
    expect(assessRole(research({ status: "unreachable" }))).toMatchObject({ primary: "Unverified", status: "Unverified" });
  });
  it("a technology-sounding company alone does not earn a category", () => {
    expect(assessRole(research({ title: "Acme Technologies", description: "Leading technology company", textSample: "Welcome to Acme Technologies" })).primary).toBe("Unverified");
  });
  it("only ever returns approved categories", () => {
    const { phrase, category } = jobTitlesIn("We are hiring a MERN stack developer and a Full Stack Engineer")[0];
    expect(phrase).toBeTruthy();
    expect(APPROVED_ROLE_CATEGORIES).toContain(category);
  });
});

describe("company assessment", () => {
  it("Verified when the site is on the same domain and names the stated company", () => {
    const a = assessCompany("acme.com", ["Acme Software Pvt Ltd"], research({ title: "Acme - Software for everyone", textSample: "Acme builds software" }));
    expect(a.status).toBe("Verified");
    expect(a.url).toBe("https://acme.com/");
  });
  it("Partially Verified when the site is live but does not name the stated company (conflicting company information)", () => {
    const a = assessCompany("acme.com", ["Totally Different Ltd"], research({ title: "Acme", textSample: "Acme builds software" }));
    expect(a.status).toBe("Partially Verified");
    expect(a.notes.join(" ")).toMatch(/does not name the stated company/);
  });
  it("Partially Verified when the domain redirects elsewhere", () => {
    const a = assessCompany("acme.com", ["Acme"], research({ finalDomain: "other.org", finalUrl: "https://other.org/", title: "Acme" }));
    expect(a.status).toBe("Partially Verified");
  });
  it("Unverified (and no URL) for unreachable, parked, robots-blocked or unresearched domains", () => {
    for (const status of ["unreachable", "parked", "blocked-by-robots", "error"] as const) {
      const a = assessCompany("acme.com", ["Acme"], research({ status }));
      expect(a.status, status).toBe("Unverified");
      expect(a.url).toBe("");
    }
    expect(assessCompany("acme.com", ["Acme"], undefined).status).toBe("Unverified");
  });
  it("notes when sources disagree about the company name", () => {
    const a = assessCompany("acme.com", ["Acme", "Zenith"], research({ title: "Acme" }));
    expect(a.notes.join(" ")).toMatch(/different company names/);
  });
});

describe("resume / restart of research", () => {
  const log = [research({ domain: "a.com" }), research({ domain: "b.com", status: "unreachable" }), research({ domain: "b.com", status: "researched" }), research({ domain: "c.com", status: "error" })]
    .map((r) => JSON.stringify(r))
    .join("\n");
  it("later log lines win and a half-written last line is ignored", () => {
    const m = parseResearchJsonl(log + '\n{"domain":"d.com","sta');
    expect([...m.keys()].sort()).toEqual(["a.com", "b.com", "c.com"]);
    expect(m.get("b.com")?.status).toBe("researched");
  });
  it("skips finished domains, honours limit, and only retries failures when asked", () => {
    const done = parseResearchJsonl(log);
    expect(selectPendingDomains(["a.com", "b.com", "c.com", "d.com", "e.com"], done)).toEqual(["d.com", "e.com"]);
    expect(selectPendingDomains(["a.com", "c.com", "d.com"], done, { retryErrors: true })).toEqual(["c.com", "d.com"]);
    expect(selectPendingDomains(["d.com", "e.com", "f.com"], done, { limit: 2 })).toEqual(["d.com", "e.com"]);
    expect(selectPendingDomains(["d.com", "d.com"], done)).toEqual(["d.com"]);
  });
});

describe("master database build, schema and Part 2 contract", () => {
  const raw = extractDataJson(
    JSON.stringify([
      { SNo: 1, Name: "Jane Doe", Email: "jane.doe@acme.com", Title: "Head of HR", Company: "Acme Software" },
      { SNo: 2, Name: "Some One", Email: "someone@gmail.com", Title: "Recruiter", Company: "Mystery Co" },
      { SNo: 3, Name: "", Email: "careers@dead.example.org", Title: "", Company: "" },
    ]),
  ).records;
  const d = dedupe(raw);
  const res = new Map<string, CompanyResearch>([
    ["acme.com", research({ title: "Acme - Software", description: "Python and data engineering consultancy", careersUrl: "https://acme.com/careers", careersTitles: ["Python Developer"], textSample: "Acme software", sources: ["https://acme.com/", "https://acme.com/careers"] })],
    ["dead.example.org", research({ domain: "dead.example.org", status: "unreachable", sources: [] })],
  ]);
  const rows = buildMaster(d.contacts, d.groups, buildCompanyRecords(d.contacts, res));
  const by = (e: string) => rows.find((r) => r.PersonEmail === e)!;

  it("produces every required field and passes strict schema validation", () => {
    expect(validateMaster(rows)).toEqual([]);
    for (const f of MASTER_FIELDS) expect(f in rows[0], f).toBe(true);
    expect(() => masterContactSchema.parse({ ...rows[0], Extra: 1 })).toThrow();
  });

  it("fills a researched contact with evidence and keeps provenance", () => {
    const j = by("jane.doe@acme.com");
    expect(j).toMatchObject({ CompanyVerificationStatus: "Verified", RoleVerificationStatus: "Verified", PrimaryRoleCategory: "Python Developer", ResolutionStatus: "resolved", CompanyDomain: "acme.com", LastResearchedAt: NOW });
    expect(j.SourceLocations).toEqual(["data.json: record 1 (SNo 1)"]);
    expect(j.ResearchSources).toContain("https://acme.com/careers");
    expect(j.PersonVerificationStatus).toBe("Partially Verified"); // never "Verified" from a listing alone
  });

  it("does not guess an employer from a public e-mail address", () => {
    const g = by("someone@gmail.com");
    expect(g).toMatchObject({ CompanyVerificationStatus: "Unverified", CompanyURL: "", CompanyDomain: "", ResolutionStatus: "unresolved", PrimaryRoleCategory: "Software Engineer", RoleBasis: "default-fallback", RoleVerificationStatus: "Unverified", PersonVerificationStatus: "Unverified" });
    expect(g.CompanyName).toBe("Mystery Co"); // only what the source states
    expect(g.ResearchNotes).toMatch(/Public e-mail provider/);
  });

  it("handles missing company, designation and URL without inventing them", () => {
    const x = by("careers@dead.example.org");
    expect(x).toMatchObject({ PersonName: "", PersonDesignation: "", CompanyName: "", CompanyURL: "", CompanyVerificationStatus: "Unverified", RoleVerificationStatus: "Unverified", ContactKind: "role-mailbox" });
  });

  it("marks never-researched company domains as pending-research", () => {
    const r2 = buildMaster(d.contacts, d.groups, buildCompanyRecords(d.contacts, new Map()));
    expect(r2.find((r) => r.PersonEmail === "jane.doe@acme.com")?.ResolutionStatus).toBe("pending-research");
    expect(validateMaster(r2)).toEqual([]);
  });

  it("ContactIDs are stable across rebuilds and independent of research", () => {
    const r2 = buildMaster(d.contacts, d.groups, buildCompanyRecords(d.contacts, new Map()));
    expect(r2.map((r) => r.ContactID)).toEqual(rows.map((r) => r.ContactID));
  });

  it("schema validation catches broken rows", () => {
    const bad = { ...rows[0], PersonEmail: "UPPER@Case.com" };
    expect(validateMaster([bad]).length).toBeGreaterThan(0);
    expect(validateMaster([rows[0], rows[0]]).some((i) => i.problem === "duplicate ContactID")).toBe(true);
    expect(validateMaster([{ ...rows[0], PrimaryRoleCategory: "Wizard" }]).length).toBeGreaterThan(0);
    expect(validateMaster([{ ...by("jane.doe@acme.com"), CareersURL: "" }]).some((i) => /careers URL/.test(i.problem))).toBe(true);
  });

  it("maps to the existing Connections fields using only roles the live validation accepts", () => {
    expect(mappingProblems()).toEqual([]);
    expect(Object.keys(APPROVED_TO_APPLY_ROLE).sort()).toEqual([...APPROVED_ROLE_CATEGORIES].sort());
    expect(toConnectionDraft(by("jane.doe@acme.com"))).toMatchObject({ name: "Jane Doe", company: "Acme", email: "jane.doe@acme.com", roleCategory: "AI/ML", applyRole: "Python Developer", role: "Head of HR" });
    expect(toConnectionDraft(by("careers@dead.example.org"))).toMatchObject({ name: "Hiring Team", salutation: "Hiring Team", companyReference: "your company" });
    expect(toConnectionDraft(by("jane.doe@acme.com"))).toMatchObject({ salutation: "Jane Doe", companyReference: "Acme" });
    expect(toConnectionDraft(by("someone@gmail.com"))).toMatchObject({ roleCategory: "SDE", applyRole: "Software Engineer" });
  });

  it("import readiness blocks unverified or public-provider rows and uses e-mail as the duplicate key", () => {
    expect(importReadiness(by("jane.doe@acme.com")).importable).toBe(true);
    expect(importReadiness(by("someone@gmail.com")).reasons).toEqual(expect.arrayContaining(["not a company-owned address", "company not verified"]));
    expect(duplicateKey(" Jane.Doe@ACME.com ")).toBe("jane.doe@acme.com");
  });
});
