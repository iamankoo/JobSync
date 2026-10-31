/**
 * The daily job search end to end with MOCK job sources, saving through the REAL Jobs service into the in-memory
 * test spreadsheet. Covers: 15 a day per kind as 5 US + 5 India + 5 other countries and 5 per member, the strict
 * eligibility filters, official-URL preference, paid-portal rejection and duplicate protection. No network.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEMBER_EMAIL_PROFILES } from "@/config/member-email-profiles";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { createJob } from "@/lib/google-sheets/jobs-service";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { loadNetworkFinderConfig, type NetworkFinderConfig } from "@/lib/network-finder/config";
import { existingConnections, existingJobs } from "@/lib/network-finder/gateways";
import { jobLedgerKeys } from "@/lib/network-finder/job-allocation";
import { runDailyJobSearch, type CompanyTask, type PipelineDeps } from "@/lib/network-finder/pipeline";
import { InMemoryQueue } from "@/lib/network-finder/queue";
import { InMemoryCompanyRegistry } from "@/lib/network-finder/registry";
import { InMemoryBatchLedger } from "@/lib/network-finder/scheduler";
import type { JobCandidate } from "@/lib/network-finder/types";
import { FakeSheets } from "../helpers/fake-sheets";
import { MockJobSource } from "../helpers/network-finder-mocks";

// Jobs columns: 0 ID 1 Company 2 JobRole 3 JobType 4 WorkMode 5 Experience 6 Stipend 7 Location 8 JobURL 9 Deadline 10 Description 11 AddedBy 12 AddedAt
let sheets: FakeSheets;
const NOON_IST = Date.UTC(2026, 9, 28, 6, 30);
const DAY = "2026-10-28";

beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
});
afterEach(() => setSheetsClientForTesting(null));

const jobs = () => sheets.dataRows("Jobs");

function setup(config: Partial<NetworkFinderConfig> = {}) {
  const jobSource = new MockJobSource();
  const deps: PipelineDeps = {
    config: { ...loadNetworkFinderConfig({ NETWORK_FINDER_ENABLED: "true", APP_TIMEZONE: "Asia/Kolkata" } as unknown as NodeJS.ProcessEnv), ...config },
    sources: [],
    jobSources: [jobSource],
    queue: new InMemoryQueue<CompanyTask>(),
    registry: new InMemoryCompanyRegistry(),
    ledger: new InMemoryBatchLedger(),
    connections: existingConnections,
    jobs: existingJobs,
    now: () => new Date(NOON_IST),
  };
  return { deps, jobSource };
}

const STACK = "You will work with React, Node.js, JavaScript, Python and MongoDB.";
let seq = 0;
function opening(region: "US" | "IN" | "OTHER", kind: "internship" | "full_time", over: Partial<JobCandidate> = {}): JobCandidate {
  const n = ++seq;
  const place = region === "US" ? "Remote - United States" : region === "IN" ? "Bengaluru, India" : "Berlin, Germany";
  const intern = kind === "internship";
  return {
    source: "Greenhouse",
    companyName: `Company ${n}`,
    title: intern ? "Full Stack Engineering Intern" : "Full Stack Engineer, New Grad",
    url: `https://boards.greenhouse.io/company${n}/jobs/${n}`,
    location: place,
    remote: region !== "IN",
    workplace: region === "IN" ? "hybrid" : "remote",
    description: `New grads and freshers welcome. ${STACK}`,
    salary: intern ? { max: 80_000, currency: "INR", period: "month" } : { max: 1_800_000, currency: "INR", period: "year" },
    ...(intern ? { employment: "internship" as const } : {}),
    ...over,
  };
}
const pool = (kind: "internship" | "full_time", perRegion = 8) => (["US", "IN", "OTHER"] as const).flatMap((r) => Array.from({ length: perRegion }, () => opening(r, kind)));

const regionOf = (location: string) => (/United States/.test(location) ? "US" : /India/.test(location) ? "IN" : "OTHER");
const kindRows = (type: "Internship" | "Full-time") => jobs().filter((r) => r[3] === type);
const counts = (rows: string[][], by: (r: string[]) => string) => rows.reduce<Record<string, number>>((m, r) => ({ ...m, [by(r)]: (m[by(r)] ?? 0) + 1 }), {});

describe("daily allocation: 5 US + 5 India + 5 other, 5 per member", () => {
  it("with verified skills for all three members: exactly 15 internships and 15 full-time, 5/5/5 by country AND by member", async () => {
    const original = MEMBER_EMAIL_PROFILES.rishii;
    // Rishii has no verified data in the real config; give the test member some so the 5/5/5 split can be shown.
    (MEMBER_EMAIL_PROFILES as Record<string, unknown>).rishii = { ...original, skills: ["javascript", "react", "nodejs", "python", "mongodb"] };
    try {
      const { deps, jobSource } = setup();
      jobSource.searchResults = [...pool("internship"), ...pool("full_time")];
      const day = await runDailyJobSearch(deps);
      expect(day.internships).toHaveLength(15);
      expect(day.fullTime).toHaveLength(15);
      for (const type of ["Internship", "Full-time"] as const) {
        const rows = kindRows(type);
        expect(rows).toHaveLength(15);
        expect(counts(rows, (r) => regionOf(r[7]))).toEqual({ US: 5, IN: 5, OTHER: 5 });
        expect(counts(rows, (r) => r[11])).toEqual({ anni: 5, lukky: 5, rishii: 5 });
        expect(new Set(rows.map((r) => r[1])).size).toBe(15); // one opening per company
      }
      // counters per kind, per country group and per member
      const k = jobLedgerKeys(DAY, "internship");
      expect(await deps.ledger.get(k.total)).toBe(15);
      expect(await deps.ledger.get(k.region("US"))).toBe(5);
      expect(await deps.ledger.get(k.member("rishii"))).toBe(5);
      // a repeat call the same day saves nothing more
      const again = await runDailyJobSearch(deps);
      expect(again.internships).toHaveLength(0);
      expect(again.fullTime).toHaveLength(0);
      expect(jobs()).toHaveLength(30);
    } finally {
      (MEMBER_EMAIL_PROFILES as Record<string, unknown>).rishii = original;
    }
  });

  it("an empty profile does not change eligibility: Rishii (no verified skills) gets his 5 from the same pool, marked as a low skill match", async () => {
    const { deps, jobSource } = setup();
    jobSource.searchResults = pool("internship");
    const day = await runDailyJobSearch(deps);
    const rows = kindRows("Internship");
    expect(counts(rows, (r) => r[11])).toEqual({ anni: 5, lukky: 5, rishii: 5 });
    expect(day.internships).toHaveLength(15);
    for (const r of rows.filter((x) => x[11] === "rishii")) expect(r[10]).toMatch(/low skill match for Rishii/);
    expect(day.warnings.filter((w) => w.startsWith("internship"))).toEqual([]);
  });

  it("each job is saved under the member it fits, with who and why in the note", async () => {
    const { deps, jobSource } = setup();
    jobSource.searchResults = [
      opening("US", "full_time", { title: "AI Engineer, New Grad", description: "New grads welcome. LLM integration and RAG pipelines in Python." }),
      opening("OTHER", "full_time", { title: "Flutter Developer, New Grad", description: "New grads welcome. Dart and Flutter mobile apps with Firebase." }),
    ];
    await runDailyJobSearch(deps);
    const rows = jobs();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      const member = r[11];
      expect(["anni", "lukky", "rishii"]).toContain(member);
      // who it was assigned to and why: a skills match, or an honest "low skill match" (never an exclusion)
      expect(r[10]).toMatch(/matches \w+ skills:|low skill match for \w+/);
    }
    // jobs are shared across members (different members, different jobs); the AI role goes to the member whose skills fit
    expect(new Set(rows.map((r) => r[11])).size).toBe(2);
    expect(["anni", "lukky"]).toContain(rows.find((r) => /AI Engineer/.test(r[2]))![11]);
  });

  it("stores the work mode and the stated pay on the job", async () => {
    const { deps, jobSource } = setup();
    jobSource.searchResults = [opening("IN", "internship")];
    await runDailyJobSearch(deps);
    const [row] = jobs();
    expect(row[4]).toBe("Hybrid");
    expect(row[6]).toBe("INR 80,000/mo");
    expect(row[7]).toBe("Bengaluru, India");
  });
});

describe("strict filters: nothing unsuitable is saved just to reach the quota", () => {
  const bad = (kind: "internship" | "full_time"): JobCandidate[] => [
    opening("US", kind, { location: "New York, NY", workplace: "onsite", remote: false }), // US must be remote
    opening("OTHER", kind, { location: "Berlin, Germany", workplace: "hybrid", remote: false }), // other countries must be remote
    opening("US", kind, { salary: kind === "internship" ? { max: 10_000, currency: "INR", period: "month" } : { max: 400_000, currency: "INR", period: "year" } }), // below the minimum
    opening("IN", kind, { description: `Freshers welcome. Minimum 7.5 CGPA required. ${STACK}` }),
    opening("IN", kind, { description: `Freshers welcome. No active backlogs. ${STACK}` }),
    opening("US", kind, { description: `Only the 2025 batch graduates can apply. ${STACK}` }),
    opening("US", kind, { description: `A registration fee is required to apply. Freshers welcome. ${STACK}` }),
    opening("US", kind, { url: "https://jobs.example.com/checkout?job=9" }),
    opening("US", kind, { title: "Senior Full Stack Engineer" }),
    opening("US", kind, { description: `5+ years of professional experience required. ${STACK}` }),
    opening("US", kind, { location: "Worldwide" }), // country not clear
    opening("US", kind, { source: "Remote OK", url: "https://remoteok.com/remote-jobs/77", salary: undefined, workplace: "remote" }), // pay unknown, not official
  ];

  it("saves none of these internships or full-time jobs, and reports why", async () => {
    const { deps, jobSource } = setup();
    jobSource.searchResults = [...bad("internship"), ...bad("full_time")];
    const day = await runDailyJobSearch(deps);
    expect(jobs()).toHaveLength(0);
    expect(day.internships).toHaveLength(0);
    expect(day.fullTime).toHaveLength(0);
    const r = day.report!.internship;
    expect(r.considered).toBe(11); // the mock source returns only intern-titled listings for internships
    expect(r.rejected + r.uncertain).toBe(r.considered);
    expect(Object.keys(r.reasons).join(" | ")).toMatch(/paid portal/);
    expect(Object.keys(r.reasons).join(" | ")).toMatch(/CGPA/);
    expect(Object.keys(r.reasons).join(" | ")).toMatch(/backlog/);
  });

  it("only the genuinely qualifying job among the bad ones is saved", async () => {
    const { deps, jobSource } = setup();
    jobSource.searchResults = [...bad("full_time"), opening("OTHER", "full_time", { companyName: "Good Co" })];
    await runDailyJobSearch(deps);
    expect(jobs().map((r) => r[1])).toEqual(["Good Co"]);
  });
});

describe("official company URL first; duplicates never saved", () => {
  it("prefers the company's own board over an aggregator for the same company and role", async () => {
    const { deps, jobSource } = setup();
    const aggregator = opening("US", "full_time", { companyName: "Same Co", source: "Remote OK", url: "https://remoteok.com/remote-jobs/1", salary: { max: 90_000, currency: "USD", period: "year" } });
    const official = opening("US", "full_time", { companyName: "Same Co", url: "https://boards.greenhouse.io/sameco/jobs/1" });
    jobSource.searchResults = [aggregator, official];
    await runDailyJobSearch(deps);
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0][8]).toBe("https://boards.greenhouse.io/sameco/jobs/1");
  });

  it("an official board outranks an aggregator when both compete for the last slot", async () => {
    const { deps, jobSource } = setup();
    const open = Array.from({ length: 5 }, (_, i) => opening("US", "full_time", { companyName: `Agg ${i}`, source: "Remote OK", url: `https://remoteok.com/remote-jobs/${i}`, salary: { max: 90_000, currency: "USD", period: "year" } }));
    const official = opening("US", "full_time", { companyName: "Official Co" });
    jobSource.searchResults = [...open, official];
    await runDailyJobSearch(deps);
    const us = jobs().filter((r) => regionOf(r[7]) === "US");
    expect(us).toHaveLength(5);
    expect(us.map((r) => r[1])).toContain("Official Co");
  });

  it("a job already in Jobs (same link, or same company and title) is not saved again", async () => {
    const { deps, jobSource } = setup();
    const a = opening("US", "full_time", { companyName: "Dup Co" });
    await createJob("anni", { company: "Dup Co", jobRole: a.title, jobType: "Full-time", location: a.location!, jobUrl: a.url }, new Date(NOON_IST), { notify: false });
    const b = opening("OTHER", "full_time", { companyName: "Dup Two" });
    await createJob("anni", { company: "Dup Two", jobRole: b.title, jobType: "Full-time", location: b.location!, jobUrl: "https://elsewhere.example.com/1" }, new Date(NOON_IST), { notify: false });
    jobSource.searchResults = [a, b];
    await runDailyJobSearch(deps);
    expect(jobs()).toHaveLength(2); // only the two created above
  });

  it("REGRESSION (29–31 Oct): a scan that finds or reads nothing burns nothing — the next call searches again, and the Jobs sheet is not read when nothing qualifies", async () => {
    const { deps, jobSource } = setup();
    let jobReads = 0;
    const realList = deps.jobs.list.bind(deps.jobs);
    deps.jobs = { ...deps.jobs, list: async () => (jobReads++, realList()) };
    jobSource.searchResults = [];
    await runDailyJobSearch(deps);
    await runDailyJobSearch(deps);
    expect(jobSource.searches.length).toBe(4); // two kinds × two calls: no "once per hour" key was spent
    expect(jobReads).toBe(0);
    // the source recovers on the next call and the jobs are saved
    jobSource.searchResults = pool("full_time", 2);
    const day = await runDailyJobSearch(deps);
    expect(day.fullTime.length).toBe(6);
    expect(jobReads).toBeGreaterThan(0);
  });

  it("stops searching for a kind once its quota is full", async () => {
    const { deps, jobSource } = setup();
    jobSource.searchResults = pool("full_time", 8);
    await runDailyJobSearch(deps);
    const searches = jobSource.searches.filter((q) => q.employment === "full_time").length;
    await runDailyJobSearch(deps);
    expect(jobSource.searches.filter((q) => q.employment === "full_time").length).toBe(searches);
  });

  it("records the day's funnel (discovered → parsed → rejected → eligible → duplicates → allocated → saved) with counts only", async () => {
    const { deps, jobSource } = setup();
    jobSource.searchResults = [...pool("full_time", 2), opening("US", "full_time", { title: "Senior Staff Engineer", description: "8+ years of experience required." }), opening("US", "full_time", { location: "New York, NY", workplace: "onsite" })];
    const day = await runDailyJobSearch(deps);
    const r = day.report!.full_time;
    expect(r).toMatchObject({ discovered: 8, parsed: 8, rejected: 2, eligible: 6, duplicates: 0, allocated: 6 });
    expect(r.saved).toHaveLength(6);
    const note = JSON.parse((await deps.ledger.getNote!(`${DAY}#funnel-full-time`))!);
    expect(note).toMatchObject({ scans: 1, discovered: 8, parsed: 8, rejected: 2, eligible: 6, allocated: 6, saved: 6 });
    expect(JSON.stringify(note)).not.toMatch(/Company \d/); // no company names in the record
  });

  it("official seed boards are handed to the sources as the supply, independent of any discovered company", async () => {
    const { deps, jobSource } = setup();
    deps.seedBoards = [{ name: "Acme Labs", ats: "greenhouse", token: "acmelabs" }, { name: "Beta", ats: "lever", token: "beta" }];
    await runDailyJobSearch(deps);
    const q = jobSource.searches[0];
    expect(q.companies?.map((c) => c.careersUrl)).toEqual(["https://boards.greenhouse.io/acmelabs", "https://jobs.lever.co/beta"]);
    expect(await deps.registry.all()).toHaveLength(0);
  });

  it("the quota is per local day: tomorrow searches again", async () => {
    const { deps, jobSource } = setup();
    jobSource.searchResults = pool("full_time", 4);
    await runDailyJobSearch(deps);
    const first = jobs().length;
    expect(first).toBe(12);
    deps.now = () => new Date(NOON_IST + 24 * 3_600_000);
    jobSource.searchResults = pool("full_time", 4);
    await runDailyJobSearch(deps);
    expect(jobs().length).toBe(first + 12);
  });
});

describe("REGRESSION: eligibility is the same for every member, whatever their profile holds", () => {
  type Profiles = typeof MEMBER_EMAIL_PROFILES;
  const states: Record<string, (real: Profiles[keyof Profiles]) => Profiles[keyof Profiles]> = {
    complete: (real) => ({ ...real, skills: ["javascript", "typescript", "react", "nextjs", "nodejs", "express", "mongodb", "python", "rest-apis", "llm-integration", "rag"] }),
    partial: (real) => ({ ...real, skills: ["javascript", "python"] }),
    empty: (real) => ({ ...real, skills: [], highlights: [] }),
  };
  const withProfiles = async <T,>(state: string, fn: () => Promise<T>): Promise<T> => {
    const saved = { ...MEMBER_EMAIL_PROFILES };
    for (const m of ["anni", "lukky", "rishii"] as const) (MEMBER_EMAIL_PROFILES as Record<string, unknown>)[m] = states[state](saved[m]);
    try {
      return await fn();
    } finally {
      for (const m of ["anni", "lukky", "rishii"] as const) (MEMBER_EMAIL_PROFILES as Record<string, unknown>)[m] = saved[m];
    }
  };
  /** 15 genuinely qualifying internships (5 per country group) plus listings that fail one common rule each. */
  const fixedPool = () => {
    seq = 1000;
    const good = (["US", "IN", "OTHER"] as const).flatMap((r) => Array.from({ length: 5 }, () => opening(r, "internship", { title: "Software Engineering Intern", description: "Freshers welcome. Backend services and tooling." })));
    const bad = [
      opening("US", "internship", { workplace: "onsite", remote: false, location: "New York, NY" }),
      opening("US", "internship", { description: "Freshers welcome. Minimum 8 CGPA." }),
      opening("IN", "internship", { description: "Freshers welcome. No active backlogs." }),
      opening("OTHER", "internship", { description: "Only the 2025 batch." }),
      opening("OTHER", "internship", { salary: { max: 5_000, currency: "INR", period: "month" } }),
    ];
    return { good, bad, all: [...good, ...bad] };
  };

  it.each(["complete", "partial", "empty"])("%s profiles: the same jobs qualify and the same are rejected; 5 US + 5 India + 5 other, 5 per member", async (state) => {
    await withProfiles(state, async () => {
      const { deps, jobSource } = setup();
      const { good, all } = fixedPool();
      jobSource.searchResults = all;
      const day = await runDailyJobSearch(deps);
      const rows = kindRows("Internship");
      expect(new Set(rows.map((r) => r[8]))).toEqual(new Set(good.map((g) => g.url))); // exactly the qualifying 15, no more, no fewer
      expect(counts(rows, (r) => regionOf(r[7]))).toEqual({ US: 5, IN: 5, OTHER: 5 });
      expect(counts(rows, (r) => r[11])).toEqual({ anni: 5, lukky: 5, rishii: 5 });
      expect(day.report!.internship).toMatchObject({ considered: 20, rejected: 5, uncertain: 0 });
    });
  });

  it("the verdict for each job is identical under complete, partial and empty profiles", async () => {
    const { all } = fixedPool();
    const { evaluateJob } = await import("@/lib/network-finder/job-eligibility");
    const verdicts = async (state: string) => withProfiles(state, async () => all.map((j) => JSON.stringify(evaluateJob(j, "internship"))));
    const complete = await verdicts("complete");
    expect(await verdicts("partial")).toEqual(complete);
    expect(await verdicts("empty")).toEqual(complete);
  });

  it("the unverified-skills rule still holds: an empty profile gains no skills, and the note says the match is low", async () => {
    await withProfiles("empty", async () => {
      const { deps, jobSource } = setup();
      jobSource.searchResults = [opening("US", "internship", { description: "Freshers welcome. React, Node.js and MongoDB." })];
      await runDailyJobSearch(deps);
      const [row] = jobs();
      expect(row[10]).toMatch(/low skill match/);
      expect(row[10]).not.toMatch(/matches \w+ skills:/);
      expect(MEMBER_EMAIL_PROFILES.anni.skills).toEqual([]);
    });
  });
});

describe("board reading across the two kinds in one run", () => {
  it("REGRESSION (31 Oct, live logs): the full-time pass reuses the boards the internship pass listed even when no time is left to read new ones", async () => {
    const { createCompanyBoardSource } = await import("@/lib/network-finder/providers/job-boards");
    const { mockWeb, testFetcher } = await import("../helpers/network-finder-mocks");
    const gh = JSON.stringify({ jobs: [
      { id: 1, title: "Software Engineer Intern", absolute_url: "https://boards.greenhouse.io/acme/jobs/1", location: { name: "Remote - United States" } },
      { id: 2, title: "Software Engineer, New Grad", absolute_url: "https://boards.greenhouse.io/acme/jobs/2", location: { name: "Remote - United States" } },
    ] });
    const web = mockWeb({ "https://boards-api.greenhouse.io/v1/boards/acme/jobs": { body: gh, type: "application/json" } });
    const source = createCompanyBoardSource(testFetcher(web.fetchFn));
    const companies = [{ key: "acme", name: "Acme", careersUrl: "https://boards.greenhouse.io/acme" }] as never;
    const first = await source.searchJobs!({ keywords: [], employment: "internship", limit: 10, companies });
    expect(first.map((j) => j.title)).toEqual(["Software Engineer Intern"]);
    const requests = web.requests.length;
    // no time left: a new board could not be read, but the cached one still serves the full-time pass
    const second = await source.searchJobs!({ keywords: [], employment: "full_time", limit: 10, companies, deadline: Date.now() + 1000 });
    expect(second.map((j) => j.title)).toEqual(["Software Engineer, New Grad"]);
    expect(web.requests.length).toBe(requests);
  });
});
