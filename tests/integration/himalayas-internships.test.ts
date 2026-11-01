import { describe, expect, it } from "vitest";
import { JobIndex } from "@/lib/network-finder/dedupe";
import { evaluateJob } from "@/lib/network-finder/job-eligibility";
import { createHimalayasSource, himalayasCandidate } from "@/lib/network-finder/providers/himalayas";
import type { JobCandidate } from "@/lib/network-finder/types";
import { mockWeb, testFetcher } from "../helpers/network-finder-mocks";

const NOW = new Date("2026-11-01T06:00:00Z").getTime();
const ctx = { nowMs: NOW, timeZone: "Asia/Kolkata" };
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

/** A Himalayas internship that meets every condition of the exception. */
function intern(over: Partial<JobCandidate> = {}): JobCandidate {
  return {
    source: "Himalayas", sourceId: "https://himalayas.app/companies/acme/jobs/backend-intern", companyName: "Acme", title: "Backend Software Engineer Intern",
    url: "https://apply.example-portal.net/j/backend-intern", location: "Worldwide", remote: true, workplace: "remote", employment: "internship", entryLevel: true,
    postedAt: daysAgo(3), description: "A paid internship for students and freshers. You will build APIs with Python and Django, SQL and Docker.",
    salary: { min: 800, max: 1200, currency: "USD", period: "month" },
    ...over,
  };
}

describe("Himalayas internships: the controlled 'not verified' exception", () => {
  it("an eligible fresher internship with no degree or year stated qualifies, as NOT VERIFIED (never confirmed)", () => {
    const ev = evaluateJob(intern(), "internship", ctx);
    expect(ev.verdict).toBe("qualifies");
    expect(ev.educationVerified).toBe(false);
    expect(ev.notes.join(" ")).toMatch(/NOT VERIFIED/);
  });

  it("a stated 2027 B.Tech / B.E. internship is still verified normally", () => {
    const ev = evaluateJob(intern({ description: "Internship for B.Tech / B.E. students graduating in 2027. Python, Django, SQL." }), "internship", ctx);
    expect(ev.verdict).toBe("qualifies");
    expect(ev.educationVerified).toBe(true);
  });

  it("an explicit Master's / PhD requirement is rejected", () => {
    expect(evaluateJob(intern({ description: "Internship for Master's or PhD students in computer science. Python." }), "internship", ctx).verdict).toBe("reject");
    expect(evaluateJob(intern({ description: "Open to M.Tech students only. Python and Django." }), "internship", ctx).verdict).toBe("reject");
  });

  it("without student / fresher / entry-level wording it stays uncertain", () => {
    const ev = evaluateJob(intern({ entryLevel: false, description: "Work on our Python services with SQL and Docker. Strong problem solving." }), "internship", ctx);
    expect(ev.verdict).toBe("uncertain");
  });

  it("must call itself an internship", () => {
    const ev = evaluateJob(intern({ title: "Backend Software Engineer", employment: undefined }), "internship", ctx);
    expect(ev.verdict).toBe("uncertain");
  });

  it("a wrong role is rejected even when it is a student internship", () => {
    expect(evaluateJob(intern({ title: "Marketing Intern", description: "Internship for students and freshers in social media marketing." }), "internship", ctx).verdict).toBe("reject");
  });

  it("US-only remote is rejected; worldwide and India-inclusive lists pass", () => {
    expect(evaluateJob(intern({ location: "United States" }), "internship", ctx).verdict).toBe("reject");
    expect(evaluateJob(intern({ location: "Canada, United States" }), "internship", ctx).verdict).toBe("reject");
    expect(evaluateJob(intern({ location: "Worldwide" }), "internship", ctx).verdict).toBe("qualifies");
    const india = evaluateJob(intern({ location: "India, Brazil" }), "internship", ctx);
    expect(india.verdict).toBe("qualifies");
    expect(india.region).toBe("IN");
  });

  it("the existing stipend threshold applies: below is rejected, above passes, undisclosed stays uncertain", () => {
    const rupees = (monthly: number) => intern({ location: "India", salary: { max: monthly, currency: "INR", period: "month" } });
    expect(evaluateJob(rupees(20_000), "internship", ctx).verdict).toBe("reject");
    expect(evaluateJob(rupees(40_000), "internship", ctx).verdict).toBe("qualifies");
    const none = evaluateJob(intern({ salary: undefined }), "internship", ctx);
    expect(none.verdict).toBe("uncertain");
    expect(none.reasons.join(" ")).toMatch(/pay not disclosed/);
  });

  it("a missing, too-old or expired listing is never saved", () => {
    expect(evaluateJob(intern({ postedAt: undefined }), "internship", ctx).verdict).toBe("uncertain");
    expect(evaluateJob(intern({ postedAt: daysAgo(200) }), "internship", ctx).verdict).toBe("reject");
    expect(evaluateJob(intern({ expiresAt: daysAgo(1) }), "internship", ctx).verdict).toBe("reject");
    expect(evaluateJob(intern({ expiresAt: new Date(NOW + 5 * 86_400_000).toISOString() }), "internship", ctx).verdict).toBe("qualifies");
  });

  it("a payment-required listing is rejected", () => {
    const ev = evaluateJob(intern({ description: "Paid internship program for students: pay a registration fee of 5000 to join the program. Python." }), "internship", ctx);
    expect(ev.verdict).toBe("reject");
  });

  it("a duplicate of a job already in Jobs (same link) is recognised", () => {
    const index = JobIndex.from([{ jobUrl: "https://apply.example-portal.net/j/backend-intern", company: "Acme", jobRole: "Backend Software Engineer Intern" }] as never);
    expect(index.duplicateOf(intern())).not.toBeNull();
    expect(index.duplicateOf(intern({ url: "https://other.example/x", companyName: "Other" }))).toBeNull();
  });

  it("FULL-TIME listings never use the exception: a missing degree keeps the existing policy (uncertain on an aggregator)", () => {
    const fullTime = intern({ title: "Junior Backend Software Engineer", employment: "full_time", salary: { max: 2_400_000, currency: "INR", period: "year" }, description: "Entry-level role for freshers and new grads. Python, Django, SQL." });
    const ev = evaluateJob(fullTime, "full_time", ctx);
    expect(ev.verdict).toBe("uncertain");
    expect(ev.reasons.join(" ")).toMatch(/degree/i);
  });
});

describe("the Himalayas source", () => {
  const list = (jobs: unknown[], totalCount = 40) => ({ body: JSON.stringify({ jobs, totalCount }), type: "application/json" });
  const posting = (over: Record<string, unknown> = {}) => ({
    title: "Data Engineering Intern", companyName: "Acme", employmentType: "Intern", seniority: ["Entry-level"], locationRestrictions: [], description: "<p>For students</p>",
    excerpt: "Internship", pubDate: Math.floor((NOW - 86_400_000) / 1000), expiryDate: null, applicationLink: "https://apply.example-portal.net/j/1", guid: "https://himalayas.app/companies/acme/jobs/1", ...over,
  });

  it("reads internships only (one request), keeps the listing's own application link and names Himalayas as the source", async () => {
    const web = mockWeb({ "https://himalayas.app/jobs/api/search?country=IN&employment_type=Intern&sort=recent&page=1": list([posting()]) });
    const source = createHimalayasSource(testFetcher(web.fetchFn));
    expect(await source.searchJobs!({ keywords: [], employment: "full_time", limit: 10, cursor: 0 })).toEqual([]);
    expect(web.requests.filter((r) => r.url.includes("/jobs/api/")).length).toBe(0);
    const found = await source.searchJobs!({ keywords: [], employment: "internship", limit: 10, cursor: 0 });
    expect(web.requests.filter((r) => r.url.includes("/jobs/api/")).length).toBe(1);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ source: "Himalayas", url: "https://apply.example-portal.net/j/1", location: "Worldwide", entryLevel: true, employment: "internship" });
    expect(evaluateJob(found[0], "internship", ctx).verdict).not.toBe("reject");
  });

  it("alternates between the India and the worldwide queries from one scan to the next", async () => {
    const web = mockWeb({
      "https://himalayas.app/jobs/api/search?country=IN&employment_type=Intern&sort=recent&page=1": list([]),
      "https://himalayas.app/jobs/api/search?worldwide=true&employment_type=Intern&sort=recent&page=1": list([]),
    });
    const source = createHimalayasSource(testFetcher(web.fetchFn));
    await source.searchJobs!({ keywords: [], employment: "internship", limit: 10, cursor: 0 });
    await source.searchJobs!({ keywords: [], employment: "internship", limit: 10, cursor: 1 });
    expect(web.requests.map((r) => r.url).filter((u) => u.includes("/jobs/api/")).map((u) => /worldwide/.test(u))).toEqual([false, true]);
  });

  it("drops a posting without a genuine https application link, and a talent pool open to every level is not 'entry-level'", () => {
    expect(himalayasCandidate(posting({ applicationLink: "http://apply.example-portal.net/j/1", guid: "" }) as never)).toBeNull();
    expect(himalayasCandidate(posting({ applicationLink: undefined, guid: undefined }) as never)).toBeNull();
    const pool = himalayasCandidate(posting({ seniority: ["Entry-level", "Mid-level", "Senior"] }) as never)!;
    expect(pool.entryLevel).toBeUndefined();
  });
});
