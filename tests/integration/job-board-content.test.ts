import { describe, expect, it } from "vitest";
import { SEED_BOARDS, boardUrl } from "@/config/job-boards";
import { evaluateJob } from "@/lib/network-finder/job-eligibility";
import { createCompanyBoardSource, sweepScans } from "@/lib/network-finder/providers/job-boards";
import { mockWeb, testFetcher } from "../helpers/network-finder-mocks";

const NOW = new Date("2026-11-01T06:00:00Z").getTime();
const ctx = { nowMs: NOW, timeZone: "Asia/Kolkata" };
const companies = [{ key: "acme", name: "Acme", careersUrl: "https://boards.greenhouse.io/acme" }] as never;
const LIST = "https://boards-api.greenhouse.io/v1/boards/acme/jobs";
const json = (body: unknown) => ({ body: JSON.stringify(body), type: "application/json" });
const escaped = (html: string) => html.replace(/</g, "&lt;").replace(/>/g, "&gt;");

const posting = (id: number, title: string, content: string) => ({
  id, title, absolute_url: `https://boards.greenhouse.io/acme/jobs/${id}`, location: { name: "Bengaluru, India" }, first_published: "2026-10-30T09:00:00Z", content: escaped(`<p>${content}</p>`),
});

describe("Greenhouse: one request per board returns the descriptions", () => {
  it("a plainly titled role is decided on its description (no early-career title needed), with no per-job request", async () => {
    const web = mockWeb({
      [`${LIST}?content=true`]: json({ jobs: [
        posting(1, "Software Engineer", "We welcome new grads and the 2027 batch. B.Tech / B.E. in Computer Science. 0-2 years of experience."),
        posting(2, "Software Engineer", "You bring 6+ years of experience building distributed systems."),
      ] }),
    });
    const source = createCompanyBoardSource(testFetcher(web.fetchFn));
    const found = await source.searchJobs!({ keywords: [], employment: "full_time", limit: 10, companies });
    expect(web.requests.map((r) => r.url).filter((u) => u.includes("/boards/acme/"))).toEqual([`${LIST}?content=true`]);
    const verdicts = Object.fromEntries(found.map((j) => [j.sourceId, evaluateJob(j, "full_time", ctx).verdict]));
    expect(found.every((j) => j.description)).toBe(true);
    expect(verdicts["1"]).not.toBe("reject");
    // the experienced posting is not offered at all (rejected on its text) when the caller screens listings
    const screened = await createCompanyBoardSource(testFetcher(mockWeb({ [`${LIST}?content=true`]: json({ jobs: [posting(2, "Software Engineer", "You bring 6+ years of experience.")] }) }).fetchFn)).searchJobs!({
      keywords: [], employment: "full_time", limit: 10, companies, accept: (j) => evaluateJob(j, "full_time", ctx).verdict !== "reject",
    });
    expect(screened).toEqual([]);
  });

  it("the posted pay is looked up only for a listing that already meets every other rule", async () => {
    const web = mockWeb({
      [`${LIST}?content=true`]: json({ jobs: [posting(1, "Software Engineer, New Grad", "2027 batch. B.Tech / B.E. Computer Science."), posting(2, "Software Engineer, New Grad", "Class of 2025 only.")] }),
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs/1?pay_transparency=true": json({ id: 1, content: escaped("<p>2027 batch. B.Tech / B.E. Computer Science.</p>"), pay_input_ranges: [{ min_cents: 1_800_000_00, max_cents: 2_400_000_00, currency_type: "INR" }] }),
    });
    const source = createCompanyBoardSource(testFetcher(web.fetchFn));
    const found = await source.searchJobs!({
      keywords: [], employment: "full_time", limit: 10, companies,
      accept: (j) => evaluateJob(j, "full_time", ctx).verdict !== "reject",
      confirm: (j) => evaluateJob(j, "full_time", ctx).verdict === "qualifies",
    });
    const details = web.requests.map((r) => r.url).filter((u) => u.includes("pay_transparency"));
    expect(details).toEqual(["https://boards-api.greenhouse.io/v1/boards/acme/jobs/1?pay_transparency=true"]);
    expect(found.map((j) => j.sourceId)).toEqual(["1"]);
    expect(found[0].salary?.currency).toBe("INR");
  });

  it("a board whose description list cannot be read falls back to the plain list and the early-career detail requests", async () => {
    const web = mockWeb({
      [`${LIST}?content=true`]: { body: "{}", status: 500, type: "application/json" },
      [LIST]: json({ jobs: [{ id: 1, title: "Software Engineer, New Grad", absolute_url: "https://boards.greenhouse.io/acme/jobs/1", location: { name: "Bengaluru, India" }, first_published: "2026-10-30T09:00:00Z" }] }),
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs/1?pay_transparency=true": json({ id: 1, content: escaped("<p>2027 batch.</p>") }),
    });
    const source = createCompanyBoardSource(testFetcher(web.fetchFn));
    const found = await source.searchJobs!({ keywords: [], employment: "full_time", limit: 10, companies });
    expect(found).toHaveLength(1);
    expect(found[0].description).toContain("2027 batch");
  });
});

describe("the board list", () => {
  it("covers Lever as well as Greenhouse, and every seeded board maps to a board the job source can read", () => {
    const kinds = new Set(SEED_BOARDS.map((b) => b.ats));
    expect(kinds).toEqual(new Set(["greenhouse", "lever"]));
    const keys = SEED_BOARDS.map((b) => b.token);
    expect(new Set(keys).size).toBe(keys.length); // no token is listed twice (the token is the board's key)
    expect(boardUrl({ ats: "lever", token: "paytm" })).toBe("https://jobs.lever.co/paytm");
  });

  it("a sweep is as long as the slowest system's list, not the total number of boards (the systems are read in parallel)", () => {
    const gh = Array.from({ length: 125 }, (_, i) => ({ careersUrl: `https://boards.greenhouse.io/b${i}` }));
    const lever = Array.from({ length: 9 }, (_, i) => ({ careersUrl: `https://jobs.lever.co/l${i}` }));
    expect(sweepScans(gh)).toBe(11); // ceil(125 / 12)
    expect(sweepScans([...gh, ...lever])).toBe(11);
    expect(sweepScans(lever)).toBe(2); // ceil(9 / 6)
    expect(sweepScans([])).toBe(1);
  });
});
