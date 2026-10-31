import { describe, expect, it } from "vitest";
import { allocate, memberFit, pickJobForMember, type EvaluatedJob } from "@/lib/network-finder/job-allocation";
import { detectRegion, detectWorkplace, evaluateJob, graduationYears, isPaidPortal, parsePayText, payInInr, requiredExperienceYears, sourceTier, type JobEvaluation, type Region } from "@/lib/network-finder/job-eligibility";
import type { JobCandidate } from "@/lib/network-finder/types";

const job = (over: Partial<JobCandidate> = {}): JobCandidate => ({
  source: "Greenhouse",
  companyName: "Acme Robotics",
  title: "Software Engineer, New Grad",
  url: "https://boards.greenhouse.io/acme/jobs/1",
  location: "Remote - United States",
  remote: true,
  workplace: "remote",
  description: "New grads welcome. You will build React and Node.js services with PostgreSQL.",
  salary: { min: 90_000, max: 120_000, currency: "USD", period: "year" },
  ...over,
});
const full = (over: Partial<JobCandidate> = {}) => evaluateJob(job(over), "full_time");
const intern = (over: Partial<JobCandidate> = {}) => evaluateJob(job({ title: "Software Engineering Intern", employment: "internship", salary: { max: 1000, currency: "USD", period: "month" }, ...over }), "internship");

describe("country, work mode", () => {
  it("places a listing in exactly one country group", () => {
    expect(detectRegion("Remote - United States")).toBe("US");
    expect(detectRegion("New York, NY")).toBe("US");
    expect(detectRegion("Bengaluru, India")).toBe("IN");
    expect(detectRegion("Berlin, Germany")).toBe("OTHER");
    expect(detectRegion("London")).toBe("OTHER");
    // several countries, or no country at all: cannot be placed
    expect(detectRegion("United States or India")).toBeNull();
    expect(detectRegion("Worldwide")).toBeNull();
    expect(detectRegion("Anywhere")).toBeNull();
    expect(detectRegion(undefined)).toBeNull();
  });

  it("reads remote / hybrid / on-site from the source or the text", () => {
    expect(detectWorkplace({ title: "Engineer", remote: true })).toBe("remote");
    expect(detectWorkplace({ title: "Engineer", location: "Pune (Hybrid)" })).toBe("hybrid");
    expect(detectWorkplace({ title: "Engineer", location: "Pune, on-site" })).toBe("onsite");
    expect(detectWorkplace({ title: "Engineer", location: "Pune" })).toBeNull();
    expect(detectWorkplace({ title: "Engineer", workplace: "onsite", remote: true })).toBe("onsite");
  });

  it("US jobs must be REMOTE (full-time)", () => {
    expect(full().verdict).toBe("qualifies");
    expect(full().region).toBe("US");
    for (const workplace of ["hybrid", "onsite"] as const) {
      const e = full({ workplace, remote: false, location: "New York, NY" });
      expect(e.verdict).toBe("reject");
      expect(e.reasons.join()).toMatch(/must be remote/);
    }
  });

  it("other-country jobs must be REMOTE; US/other with no stated work mode is only uncertain", () => {
    expect(full({ location: "Berlin, Germany" }).verdict).toBe("qualifies");
    expect(full({ location: "Berlin, Germany", workplace: "onsite", remote: false }).verdict).toBe("reject");
    const unknown = full({ location: "Berlin, Germany", workplace: undefined, remote: false });
    expect(unknown.verdict).toBe("uncertain");
    expect(unknown.reasons.join()).toMatch(/remote not stated/);
  });

  it("India allows remote, hybrid and on-site for full-time", () => {
    for (const workplace of ["remote", "hybrid", "onsite"] as const) {
      expect(full({ location: "Bengaluru, India", workplace, remote: workplace === "remote", salary: { max: 1_500_000, currency: "INR", period: "year" } }).verdict).toBe("qualifies");
    }
  });

  it("a job whose country is unclear is not treated as qualifying", () => {
    expect(full({ location: "Worldwide" }).verdict).toBe("uncertain");
  });
});

describe("pay", () => {
  it("converts stated amounts to INR for comparison only", () => {
    expect(payInInr(30_000, "INR", "month")!.monthly).toBe(30_000);
    expect(payInInr(12, "USD", "year")!.annual).toBeGreaterThan(900);
    expect(payInInr(500, "USD", "month")!.monthly).toBeCloseTo(42_500, -2);
    expect(payInInr(10, "XXX", "year")).toBeNull();
  });

  it("parses pay written as text", () => {
    expect(parsePayText("₹12-18 LPA")).toMatchObject({ currency: "INR", period: "year", max: 1_800_000 });
    expect(parsePayText("$80k - $120k")).toMatchObject({ currency: "USD", period: "year", max: 120_000 });
    expect(parsePayText("₹40,000/month")).toMatchObject({ currency: "INR", period: "month", max: 40_000 });
    expect(parsePayText("$25 per hour")).toMatchObject({ currency: "USD", period: "hour", max: 25 });
    expect(parsePayText("Unpaid")).toEqual({ unpaid: true });
    expect(parsePayText("Competitive")).toBeNull();
    // ambiguous (no period and could be monthly or yearly): never guessed
    expect(parsePayText("₹40,000")).toBeNull();
  });

  it("remote internship: at least ₹30,000 a month", () => {
    expect(intern({ salary: { max: 25_000, currency: "INR", period: "month" } }).verdict).toBe("reject");
    expect(intern({ salary: { max: 30_000, currency: "INR", period: "month" } }).verdict).toBe("qualifies");
    expect(intern({ salary: { max: 300, currency: "USD", period: "month" } }).verdict).toBe("reject"); // about ₹25,500
    expect(intern({ salary: { max: 400, currency: "USD", period: "month" } }).verdict).toBe("qualifies"); // about ₹34,000
  });

  it("India on-site internship: at least ₹50,000 a month; remote India internship only ₹30,000", () => {
    const base = { location: "Pune, India", workplace: "onsite" as const, remote: false };
    expect(intern({ ...base, salary: { max: 40_000, currency: "INR", period: "month" } }).verdict).toBe("reject");
    expect(intern({ ...base, salary: { max: 50_000, currency: "INR", period: "month" } }).verdict).toBe("qualifies");
    expect(intern({ location: "Pune, India", workplace: "remote", salary: { max: 40_000, currency: "INR", period: "month" } }).verdict).toBe("qualifies");
    // India with no stated mode counts as on-site for the pay minimum
    expect(intern({ location: "Pune, India", workplace: undefined, remote: false, salary: { max: 40_000, currency: "INR", period: "month" } }).verdict).toBe("reject");
  });

  it("full-time: at least ₹10 LPA (a range counts by its top)", () => {
    expect(full({ salary: { max: 9_000_000 / 100, currency: "INR", period: "year" }, location: "Pune, India", workplace: "hybrid", remote: false }).verdict).toBe("reject"); // 9 LPA
    expect(full({ salary: { min: 800_000, max: 1_000_000, currency: "INR", period: "year" }, location: "Pune, India", workplace: "hybrid", remote: false }).verdict).toBe("qualifies");
    expect(full({ salary: { max: 8_000, currency: "USD", period: "year" } }).verdict).toBe("reject");
    expect(full({ salary: { max: 60_000, currency: "USD", period: "year" } }).verdict).toBe("qualifies");
    expect(full({ salary: undefined, salaryText: "₹6-9 LPA" }).verdict).toBe("reject");
    expect(full({ salary: undefined, salaryText: "unpaid" }).verdict).toBe("reject");
  });

  it("pay not disclosed: allowed only for an explicit fresher listing on an official source, and noted", () => {
    const official = full({ salary: undefined });
    expect(official.verdict).toBe("qualifies");
    expect(official.payVerified).toBe(false);
    expect(official.notes).toContain("pay not disclosed in the listing");
    const aggregator = full({ salary: undefined, source: "Remote OK", url: "https://remoteok.com/remote-jobs/1" });
    expect(aggregator.verdict).toBe("uncertain");
    expect(aggregator.reasons.join()).toMatch(/pay not disclosed/);
    const noFresherSignal = full({ salary: undefined, title: "Software Engineer", description: "Build services with React." });
    expect(noFresherSignal.verdict).toBe("uncertain");
  });
});

describe("fresher / 2027 eligibility", () => {
  it("reads graduation years only in a graduation context", () => {
    expect(graduationYears("Open to the 2026 and 2027 batch")).toEqual(expect.arrayContaining([2026, 2027]));
    expect(graduationYears("Graduating in 2025")).toEqual([2025]);
    expect(graduationYears("2024/2025 pass-outs only")).toEqual(expect.arrayContaining([2024, 2025]));
    expect(graduationYears("Founded in 2019, we raised in 2023")).toEqual([]);
  });

  it("rejects a listing that names graduation years without 2027, accepts one that includes it", () => {
    expect(full({ description: "Eligibility: 2025 batch graduates only." }).verdict).toBe("reject");
    expect(full({ description: "Eligibility: 2026 and 2027 batch graduates." }).verdict).toBe("qualifies");
  });

  it("rejects minimum CGPA / percentage requirements", () => {
    for (const d of ["Minimum 7.5 CGPA required.", "Must have CGPA of 8 or above", "Candidates with 70% and above throughout", "Min. GPA 3.2"]) {
      const e = full({ description: `New grads welcome. ${d}` });
      expect(e.verdict, d).toBe("reject");
      expect(e.reasons.join()).toMatch(/CGPA/);
    }
  });

  it("rejects backlog restrictions", () => {
    for (const d of ["No active backlogs.", "Should not have any backlogs", "Backlog-free candidates only"]) {
      expect(full({ description: `Freshers welcome. ${d}` }).reasons.join(), d).toMatch(/backlog/);
    }
  });

  it("rejects senior and experienced-only roles", () => {
    expect(full({ title: "Senior Software Engineer" }).verdict).toBe("reject");
    expect(full({ title: "Staff Backend Engineer" }).verdict).toBe("reject");
    expect(full({ description: "Entry level? No: 5+ years of professional experience required." }).verdict).toBe("reject");
    expect(full({ description: "Experienced candidates only." }).verdict).toBe("reject");
    expect(requiredExperienceYears("3+ years of experience")).toBe(3);
    expect(requiredExperienceYears("0-2 years experience")).toBe(0);
    expect(requiredExperienceYears("Strong communication")).toBeNull();
  });

  it("full-time with no fresher signal is uncertain; an internship is fresher-friendly by nature", () => {
    expect(full({ title: "Backend Engineer", description: "Build APIs in Node.js." }).verdict).toBe("uncertain");
    expect(intern().verdict).toBe("qualifies");
  });
});

describe("paid portals and source quality", () => {
  it("rejects pay-to-apply listings and payment pages", () => {
    expect(isPaidPortal(job({ description: "A registration fee of $20 is required." }))).toMatch(/payment/);
    expect(isPaidPortal(job({ description: "Subscribe to apply for this job." }))).toBeTruthy();
    expect(isPaidPortal(job({ url: "https://jobs.example.com/checkout?job=1" }))).toBeTruthy();
    expect(isPaidPortal(job())).toBeNull();
    const e = full({ description: "New grads welcome. Pay a placement fee to apply." });
    expect(e.verdict).toBe("reject");
    expect(e.reasons.join()).toMatch(/paid portal/);
  });

  it("official company boards and company-owned domains outrank LinkedIn, then other open sources", () => {
    expect(sourceTier(job())).toBe("official");
    expect(sourceTier(job({ source: "Lever", url: "https://jobs.lever.co/acme/1" }))).toBe("official");
    expect(sourceTier(job({ source: "Ashby", url: "https://jobs.ashbyhq.com/acme/1" }))).toBe("official");
    expect(sourceTier(job({ source: "Careers", url: "https://acmerobotics.com/careers/1" }))).toBe("official");
    expect(sourceTier(job({ source: "LinkedIn", url: "https://www.linkedin.com/jobs/view/1" }))).toBe("linkedin");
    expect(sourceTier(job({ source: "Remote OK", url: "https://remoteok.com/remote-jobs/1" }))).toBe("open");
  });
});

// ---- allocation ---------------------------------------------------------------------------------------------------

const ev = (region: Region, over: Partial<JobEvaluation> = {}): JobEvaluation & { region: Region } => ({ verdict: "qualifies", reasons: [], workplace: "remote", tier: "official", payVerified: true, notes: [], ...over, region });
let n = 0;
const cand = (region: Region, title: string, description: string, tier: JobEvaluation["tier"] = "official"): EvaluatedJob => ({
  job: job({ companyName: `Co ${++n}`, title, description, url: `https://boards.greenhouse.io/c${n}/jobs/${n}` }),
  evaluation: ev(region, { tier }),
});
const empty = () => ({ regionUsed: {}, memberUsed: {}, companiesUsed: new Set<string>() });

describe("which member a job suits (verified skills only)", () => {
  it("fits Anni and Lukky on the technologies they really have, and Rishii on nothing", () => {
    const j = { title: "Backend Engineer", description: "Node.js, Express and MongoDB services." };
    expect(memberFit("anni", j).score).toBeGreaterThan(0);
    expect(memberFit("lukky", j).matched).toEqual(expect.arrayContaining(["Node.js", "MongoDB"]));
    expect(memberFit("rishii", j)).toEqual({ memberId: "rishii", score: 0, matched: [] });
  });

  it("a job needing skills the member lacks does not fit them (taxonomy skills are not claims)", () => {
    const j = { title: "Embedded Firmware Engineer", description: "RTOS, Verilog and board bring-up." };
    expect(memberFit("lukky", j).score).toBe(0);
  });

  it("each member is pointed at the real opening that fits their own skills", () => {
    const jobs = [
      { title: "Flutter Developer", description: "Dart and Flutter apps." },
      { title: "AI Engineer", description: "LLM integration, RAG pipelines in Python." },
    ];
    expect(pickJobForMember("lukky", jobs)?.title).toBe("AI Engineer");
    expect(pickJobForMember("anni", jobs)).toBeDefined();
    expect(pickJobForMember("lukky", [{ title: "Flutter Developer", description: "Dart and Flutter apps." }])).toBeUndefined();
    expect(pickJobForMember("anni", [{ title: "Senior Backend Engineer" }])).toBeUndefined();
  });
});

describe("daily split: 5 per country group, 5 per member, quality before quota", () => {
  const stack = "React, Node.js, JavaScript and MongoDB";
  const many = () => [
    ...Array.from({ length: 9 }, (_, i) => cand("US", "Full Stack Engineer", `${stack} #${i}`)),
    ...Array.from({ length: 9 }, (_, i) => cand("IN", "Backend Engineer", `Node.js Express MongoDB #${i}`)),
    ...Array.from({ length: 9 }, (_, i) => cand("OTHER", "Frontend Developer", `React JavaScript #${i}`)),
  ];

  it("5 per region and 5 per member, one job per company, for ALL three members (an empty profile is a low match, not an exclusion)", () => {
    const out = allocate(many(), empty());
    const byRegion = (r: Region) => out.filter((a) => a.region === r).length;
    const byMember = (m: string) => out.filter((a) => a.memberId === m).length;
    expect(byRegion("US")).toBeLessThanOrEqual(5);
    expect(byRegion("IN")).toBeLessThanOrEqual(5);
    expect(byRegion("OTHER")).toBeLessThanOrEqual(5);
    expect(byMember("anni")).toBe(5);
    expect(byMember("lukky")).toBe(5);
    expect(byMember("rishii")).toBe(5);
    expect(out).toHaveLength(15);
    expect(new Set(out.map((a) => a.job.companyName)).size).toBe(out.length);
  });

  it("skill fit only RANKS: a job nobody fits is still assigned (it passed the common rules), after the better matches", () => {
    const poor = [cand("US", "Embedded Firmware Engineer", "RTOS, Verilog and board bring-up."), cand("IN", "Salesforce Engineer", "Apex, Visualforce and Lightning."), cand("OTHER", "Backend Engineer", "Node.js and MongoDB.")];
    const out = allocate(poor, empty());
    expect(out).toHaveLength(3);
    const fits = Object.fromEntries(out.map((a) => [a.job.title, a.fit.score]));
    expect(fits["Backend Engineer"]).toBeGreaterThan(0);
    expect(fits["Embedded Firmware Engineer"]).toBe(0);
    expect(out[0].job.title).toBe("Backend Engineer"); // best match is placed first
  });

  it("counts what is already saved today (capacity carries over between calls)", () => {
    const capacity = { regionUsed: { US: 5 }, memberUsed: { anni: 4 }, companiesUsed: new Set<string>() };
    const out = allocate(many(), capacity);
    expect(out.some((a) => a.region === "US")).toBe(false);
    expect(out.filter((a) => a.memberId === "anni")).toHaveLength(1);
  });

  it("an official company board ranks above an aggregator for the same fit", () => {
    const official = cand("US", "Full Stack Engineer", stack, "official");
    const open = cand("US", "Full Stack Engineer", stack, "open");
    const out = allocate([open, official], { regionUsed: { US: 4 }, memberUsed: {}, companiesUsed: new Set() });
    expect(out).toHaveLength(1);
    expect(out[0].job).toBe(official.job);
  });

  it("a company already used today gets no second opening", () => {
    const a = cand("US", "Full Stack Engineer", stack);
    const out = allocate([a], { regionUsed: {}, memberUsed: {}, companiesUsed: new Set([a.job.companyName.toLowerCase()]) });
    expect(out).toHaveLength(0);
  });
});

describe("fresher-level titles (found by the 31 Oct source sweep: 1,300 of 1,600 full-time listings were 'uncertain')", () => {
  const undisclosed = { salary: undefined, description: "Build backend services in Go.", location: "Bengaluru, India" };
  it("treats level-one titles as fresher-friendly on an official board, but not Engineer II/III or Senior", () => {
    for (const title of ["Software Engineer I", "Software Engineer 1", "SDE-1", "SDE 1", "Backend Developer I"]) expect(full({ ...undisclosed, title }).verdict, title).toBe("qualifies");
    for (const title of ["Software Engineer II", "Software Engineer III", "Software Engineer 2", "Software Engineer"]) expect(full({ ...undisclosed, title }).verdict, title).toBe("uncertain");
  });
});
