import { describe, expect, it } from "vitest";
import {
  compareOptional, daysUntil, deadlineTone, distinctValues, EMPTY_FILTERS, filterByJobFields, formatDisplayDate, hasActiveFilters,
  matchesQuery, paginate, pageWindow, PAGE_SIZE,
} from "@/lib/jobs/query";
import { isApplied } from "@/lib/jobs/stats";
import type { ApplicationStatus, Job } from "@/types/domain";

const job = (over: Partial<Job> = {}): Job => ({
  jobId: "job_1",
  company: "Synthetic Co A",
  jobRole: "Test Role",
  jobType: "Full-time",
  location: "Testville",
  jobUrl: "https://jobs.example.test/1",
  addedBy: "anni",
  addedAt: "2026-10-09T10:00:00.000Z",
  ...over,
});

describe("search and filters", () => {
  it("matches every term case-insensitively across title, company, location, type, experience, salary and description", () => {
    const j = job({ experience: "0–1 years", stipendSalary: "₹30K / month", description: "Python and SQL" });
    expect(matchesQuery(j, "")).toBe(true);
    expect(matchesQuery(j, "  ")).toBe(true);
    expect(matchesQuery(j, "TEST role")).toBe(true);
    expect(matchesQuery(j, "synthetic testville")).toBe(true);
    expect(matchesQuery(j, "python sql")).toBe(true);
    expect(matchesQuery(j, "full-time")).toBe(true);
    expect(matchesQuery(j, "30k")).toBe(true);
    expect(matchesQuery(j, "java")).toBe(false);
    expect(matchesQuery(j, "python java")).toBe(false);
  });

  const items: { job: Job; status: ApplicationStatus }[] = [
    { job: job({ jobId: "1", company: "A", location: "X", jobType: "Full-time", experience: "Fresher" }), status: "Applied" },
    { job: job({ jobId: "2", company: "B", location: "Y", jobType: "Internship", experience: "0–1 years" }), status: "Not Applied" },
    { job: job({ jobId: "3", company: "A", location: "Y", jobType: "Internship" }), status: "Interview" },
  ];
  const run = (patch: Partial<typeof EMPTY_FILTERS>) =>
    filterByJobFields(items, (i) => i.job, (i) => i.status, { ...EMPTY_FILTERS, ...patch }).map((i) => i.job.jobId);

  it("filters by each dropdown and combines them", () => {
    expect(run({})).toEqual(["1", "2", "3"]);
    expect(run({ company: "A" })).toEqual(["1", "3"]);
    expect(run({ location: "Y" })).toEqual(["2", "3"]);
    expect(run({ jobType: "Internship" })).toEqual(["2", "3"]);
    expect(run({ experience: "Fresher" })).toEqual(["1"]);
    expect(run({ company: "A", jobType: "Internship" })).toEqual(["3"]);
    expect(run({ company: "Nope" })).toEqual([]);
  });

  it("status filter: 'Applied' means any applied status; others match exactly", () => {
    expect(run({ status: "Applied" })).toEqual(["1", "3"]);
    expect(run({ status: "Not Applied" })).toEqual(["2"]);
    expect(run({ status: "Interview" })).toEqual(["3"]);
    expect(run({ status: "Offer" })).toEqual([]);
  });

  it("reports whether any filter is active", () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, query: "x" })).toBe(true);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, status: "Applied" })).toBe(true);
  });

  it("builds dropdown options from real values only, sorted and de-duplicated", () => {
    expect(distinctValues(["b", "a", undefined, "", "b", "  "])).toEqual(["a", "b"]);
    expect(distinctValues([])).toEqual([]);
  });
});

describe("sorting helpers", () => {
  it("sorts optional values with missing ones last in both directions", () => {
    const values = [undefined, "2026-10-12", "2026-10-10"];
    expect([...values].sort((a, b) => compareOptional(a, b, "asc"))).toEqual(["2026-10-10", "2026-10-12", undefined]);
    expect([...values].sort((a, b) => compareOptional(a, b, "desc"))).toEqual(["2026-10-12", "2026-10-10", undefined]);
  });
});

describe("pagination", () => {
  const list = Array.from({ length: 25 }, (_, i) => i + 1);

  it("pages at 10 per page with correct ranges", () => {
    expect(PAGE_SIZE).toBe(10);
    const p1 = paginate(list, 1);
    expect(p1).toMatchObject({ page: 1, pageCount: 3, total: 25, from: 1, to: 10 });
    expect(p1.items).toEqual(list.slice(0, 10));
    const p3 = paginate(list, 3);
    expect(p3).toMatchObject({ from: 21, to: 25 });
    expect(p3.items).toHaveLength(5);
  });

  it("clamps out-of-range and invalid pages, and handles empty lists", () => {
    expect(paginate(list, 99).page).toBe(3);
    expect(paginate(list, 0).page).toBe(1);
    expect(paginate(list, NaN).page).toBe(1);
    expect(paginate([], 1)).toMatchObject({ page: 1, pageCount: 1, total: 0, from: 0, to: 0, items: [] });
  });

  it("builds a compact page window with gaps", () => {
    expect(pageWindow(1, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(1, 12)).toEqual([1, 2, null, 12]);
    expect(pageWindow(6, 12)).toEqual([1, null, 5, 6, 7, null, 12]);
    expect(pageWindow(12, 12)).toEqual([1, null, 11, 12]);
  });
});

describe("dates", () => {
  it("counts whole days between date-only values", () => {
    expect(daysUntil("2026-10-12", "2026-10-09")).toBe(3);
    expect(daysUntil("2026-10-09", "2026-10-09")).toBe(0);
    expect(daysUntil("2026-10-01", "2026-10-09")).toBe(-8);
    expect(daysUntil("2026-11-01", "2026-10-31")).toBe(1);
  });

  it("classifies deadlines", () => {
    const today = "2026-10-09";
    expect(deadlineTone(undefined, today)).toBe("none");
    expect(deadlineTone("2026-10-08", today)).toBe("overdue");
    expect(deadlineTone("2026-10-09", today)).toBe("urgent");
    expect(deadlineTone("2026-10-12", today)).toBe("urgent");
    expect(deadlineTone("2026-10-16", today)).toBe("soon");
    expect(deadlineTone("2026-10-17", today)).toBe("normal");
  });

  it("formats dates and timestamps in a fixed timezone", () => {
    expect(formatDisplayDate("2026-10-09", "Asia/Kolkata")).toBe("09 Oct 2026");
    expect(formatDisplayDate("2026-10-09T20:00:00.000Z", "Asia/Kolkata")).toBe("10 Oct 2026"); // 01:30 IST next day
    expect(formatDisplayDate("2026-10-09T20:00:00.000Z", "UTC")).toBe("09 Oct 2026");
    expect(formatDisplayDate(undefined, "UTC")).toBe("—");
    expect(formatDisplayDate("garbage", "UTC")).toBe("—");
  });
});

describe("status helper", () => {
  it("treats any status past Not Applied as applied (counts live in src/lib/counting.ts)", () => {
    expect(isApplied("Not Applied")).toBe(false);
    for (const st of ["Applied", "In Progress", "Interview", "Offer", "Rejected"] as const) expect(isApplied(st)).toBe(true);
  });
});
