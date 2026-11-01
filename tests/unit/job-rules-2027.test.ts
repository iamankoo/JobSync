/**
 * The 1 Nov 2026 rules: 2027 B.Tech / B.E. only, worldwide-remote-or-India, and posting-age windows by ORIGINAL posting date.
 * Pure functions plus evaluateJob; no I/O.
 */
import { describe, expect, it } from "vitest";
import { evaluateEducation } from "@/lib/network-finder/job-education";
import { evaluateJob, graduationYears, remoteScope } from "@/lib/network-finder/job-eligibility";
import { MAX_AGE_DAYS, RECENCY_WINDOWS, postingAge, windowForAge } from "@/lib/network-finder/job-recency";
import type { JobCandidate } from "@/lib/network-finder/types";

const TZ = "Asia/Kolkata";
const NOW = Date.UTC(2026, 10, 1, 6, 30); // 1 Nov 2026, 12:00 IST
const ctx = { nowMs: NOW, timeZone: TZ };
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const base = (over: Partial<JobCandidate> = {}): JobCandidate => ({
  source: "Greenhouse",
  companyName: "Acme Robotics",
  title: "Software Engineer, New Grad",
  url: "https://boards.greenhouse.io/acme/jobs/1",
  location: "Remote - Worldwide",
  remote: true,
  workplace: "remote",
  postedAt: daysAgo(3),
  description: "New grads welcome. B.Tech students graduating in 2027 can apply. You will build React and Node.js services.",
  salary: { max: 1_800_000, currency: "INR", period: "year" },
  ...over,
});
const full = (over: Partial<JobCandidate> = {}) => evaluateJob(base(over), "full_time", ctx);
const intern = (over: Partial<JobCandidate> = {}) =>
  evaluateJob(base({ title: "Software Engineering Intern", employment: "internship", salary: { max: 60_000, currency: "INR", period: "month" }, ...over }), "internship", ctx);

describe("education: 2027 B.Tech / B.E. only", () => {
  it("2027 B.Tech internship and 2027 B.E. full-time are eligible and verified", () => {
    const a = intern({ description: "Open to B.Tech students graduating in 2027. React and Node.js." });
    expect(a.verdict).toBe("qualifies");
    expect(a.educationVerified).toBe(true);
    const b = full({ description: "Freshers: B.E. / B.Tech, 2027 batch. React and Node.js." });
    expect(b.verdict).toBe("qualifies");
    expect(b.educationVerified).toBe(true);
    expect(full({ description: "Bachelor of Engineering graduates, class of 2027. New grads welcome." }).educationVerified).toBe(true);
    expect(full({ description: "Bachelor of Technology students graduating in 2027. New grads welcome." }).educationVerified).toBe(true);
    expect(full({ description: "Bachelor's degree in Computer Science, graduating in 2027. New grads welcome." }).educationVerified).toBe(true);
  });

  it("a 2027 Master's / M.Tech / MSc / PhD candidate NEVER qualifies, whatever the year", () => {
    for (const d of [
      "M.Tech students graduating in 2027 can apply.",
      "MSc students graduating in 2027 are eligible. New grads welcome.",
      "PhD candidates graduating in 2027 only.",
      "Currently pursuing a Master's degree, graduating in 2027. Freshers welcome.",
      "MBA candidates, 2027 batch. Freshers welcome.",
      "M.E. (Master of Engineering) students, 2027 batch. New grads welcome.",
      "MCA final year students, graduation 2027.",
      "Doctoral students graduating in 2027.",
    ]) {
      const e = full({ description: d });
      expect(e.verdict, d).toBe("reject");
      expect(e.reasons.join(), d).toMatch(/postgraduate-only/);
      expect(e.educationVerified).toBe(false);
    }
  });

  it("other graduation years are rejected, B.Tech or not", () => {
    expect(full({ description: "B.Tech students graduating in 2026. New grads welcome." }).verdict).toBe("reject");
    expect(full({ description: "B.E. graduates, 2028 batch. New grads welcome." }).verdict).toBe("reject");
    expect(full({ description: "B.Tech 2025 batch only." }).reasons.join()).toMatch(/graduation batch/);
  });

  it("a different degree, or an explicit exclusion of B.Tech / B.E., is rejected", () => {
    for (const d of ["B.Com graduates, 2027 batch. Freshers welcome.", "MBBS graduates only. Freshers welcome.", "BBA students graduating in 2027. Freshers welcome."]) {
      expect(full({ description: d }).verdict, d).toBe("reject");
    }
    const ex = full({ description: "Engineering students graduating in 2027. B.Tech candidates are not eligible. New grads welcome." });
    expect(ex.verdict).toBe("reject");
    expect(ex.reasons.join()).toMatch(/excludes B\.Tech/);
    // "not limited to B.Tech" is not an exclusion
    expect(full({ description: "Open to B.Tech students, not limited to the 2027 batch. New grads welcome." }).verdict).not.toBe("reject");
  });

  it("'Bachelor's or Master's' accepts the bachelor's; a PhD mention that is not a requirement does not reject", () => {
    expect(full({ description: "Bachelor's or Master's degree in Computer Science, class of 2027. New grads welcome." }).verdict).toBe("qualifies");
    expect(full({ description: "Our team includes several PhDs who mentor new grads. B.Tech 2027 batch welcome." }).verdict).toBe("qualifies");
  });

  it("a 2027 year ALONE does not verify; an unstated degree is recorded, not invented", () => {
    const only2027 = full({ description: "New grads welcome. Class of 2027. React and Node.js." });
    expect(only2027.verdict).toBe("qualifies"); // official source + fresher listing: same safe handling as undisclosed pay
    expect(only2027.educationVerified).toBe(false);
    expect(only2027.notes.join()).toMatch(/degree not stated/);
    const none = full({ description: "New grads welcome. React and Node.js." });
    expect(none.educationVerified).toBe(false);
    expect(none.notes.join()).toMatch(/degree and 2027 batch not stated: 2027 B\.Tech \/ B\.E\. eligibility is not verified/);
    // not an official source: the same gap makes it uncertain, never qualifying
    const open = full({ source: "Remote OK", url: "https://remoteok.com/remote-jobs/1", description: "New grads welcome. React and Node.js." });
    expect(open.verdict).toBe("uncertain");
    expect(open.reasons.join()).toMatch(/not verified/);
  });

  it("evaluateEducation on its own", () => {
    const years = graduationYears("graduating in 2027");
    expect(evaluateEducation("B.Tech students graduating in 2027", years).status).toBe("verified");
    expect(evaluateEducation("Master's students graduating in 2027", years).status).toBe("reject");
    expect(evaluateEducation("Students graduating in 2027", years).status).toBe("unverified");
  });
});

describe("remote: 'Remote' is not 'worldwide'", () => {
  it("a US company can qualify when the job is genuinely worldwide remote with India eligible", () => {
    const e = full({ companyName: "Bay Area Labs Inc (San Francisco, CA)", location: "Remote", description: "New grads welcome. B.Tech 2027 batch. Open to applicants residing in India and other countries." });
    expect(e.verdict).toBe("qualifies");
    expect(e.region).toBe("OTHER");
    expect(e.notes.join()).toMatch(/India are explicitly eligible/);
  });

  it("worldwide remote with no country restriction qualifies when the listing says so", () => {
    expect(full({ location: "Worldwide", description: "New grads welcome. B.Tech 2027 batch." }).verdict).toBe("qualifies");
    expect(full({ location: "Remote", description: "New grads welcome. B.Tech 2027 batch. This is a work from anywhere role." }).verdict).toBe("qualifies");
    // company headquarters in the text is not the job's work location
    expect(full({ location: "Remote", description: "Headquartered in San Francisco. Fully remote, open to candidates worldwide. B.Tech 2027 batch. New grads welcome." }).verdict).toBe("qualifies");
  });

  it("US-only, Canada-only, US/Canada and state-limited remote are rejected, with the reason", () => {
    for (const location of ["Remote - US", "Remote, United States", "Remote - Canada", "Remote - US or Canada", "Remote (California)", "Remote - UK", "Remote - EMEA"]) {
      const e = full({ location });
      expect(e.verdict, location).toBe("reject");
      expect(e.reasons.join(), location).toMatch(/not worldwide/);
    }
    for (const description of [
      "Remote role. You must be located in the United States. New grads welcome. B.Tech 2027 batch.",
      "Remote. Must be authorized to work in the US. New grads welcome. B.Tech 2027 batch.",
      "US-only remote position. New grads welcome. B.Tech 2027 batch.",
      "Remote within Canada only. New grads welcome. B.Tech 2027 batch.",
    ]) {
      const e = full({ location: "Remote", description });
      expect(e.verdict, description).toBe("reject");
      expect(e.reasons.join(), description).toMatch(/location restriction/);
    }
  });

  it("conflicting evidence is not assumed worldwide; ambiguous plain 'Remote' is uncertain", () => {
    expect(full({ location: "Worldwide", description: "Candidates must be authorized to work in the United States. New grads welcome. B.Tech 2027 batch." }).verdict).toBe("reject");
    const plain = full({ location: "Remote", description: "New grads welcome. B.Tech 2027 batch. React and Node.js." });
    expect(plain.verdict).toBe("uncertain");
    expect(plain.reasons.join()).toMatch(/Remote" alone does not show/);
    expect(remoteScope({ title: "Engineer", location: "Remote", description: "We are a global team." }).scope).toBe("unknown");
  });

  it("India keeps its rules: remote, hybrid or on-site; on-site internships need ₹50,000, remote ₹30,000", () => {
    for (const workplace of ["remote", "hybrid", "onsite"] as const) {
      expect(full({ location: "Bengaluru, India", workplace, remote: workplace === "remote", description: "New grads welcome. B.Tech 2027 batch." }).verdict).toBe("qualifies");
    }
    const inIntern = (workplace: "remote" | "hybrid" | "onsite", perMonth: number) => intern({ location: "Pune, India", workplace, remote: workplace === "remote", salary: { max: perMonth, currency: "INR", period: "month" } });
    expect(inIntern("onsite", 40_000).verdict).toBe("reject");
    expect(inIntern("onsite", 50_000).verdict).toBe("qualifies");
    expect(inIntern("remote", 30_000).verdict).toBe("qualifies");
    expect(inIntern("remote", 25_000).verdict).toBe("reject");
    // worldwide remote internships use the remote threshold (INR-equivalent)
    expect(intern({ location: "Worldwide", salary: { max: 300, currency: "USD", period: "month" } }).verdict).toBe("reject"); // ≈ ₹25,500
    expect(intern({ location: "Worldwide", salary: { max: 500, currency: "USD", period: "month" } }).verdict).toBe("qualifies"); // ≈ ₹42,500
  });
});

describe("recency windows by ORIGINAL posting date", () => {
  it("covers 0–120 days with six non-overlapping windows, newest first", () => {
    expect(RECENCY_WINDOWS.map((w) => [w.from, w.to])).toEqual([[0, 7], [8, 15], [16, 30], [31, 60], [61, 90], [91, 120]]);
    for (let d = 0; d <= MAX_AGE_DAYS; d++) expect(RECENCY_WINDOWS.filter((w) => d >= w.from && d <= w.to)).toHaveLength(1);
  });

  it("exact boundary days land in the right window; 121 days is rejected", () => {
    const cases: [number, number][] = [[0, 1], [7, 1], [8, 2], [15, 2], [16, 3], [30, 3], [31, 4], [60, 4], [61, 5], [90, 5], [91, 6], [120, 6]];
    for (const [days, window] of cases) {
      expect(windowForAge(days), `${days} days`).toBe(window);
      expect(postingAge(daysAgo(days), NOW, TZ), `${days} days`).toEqual({ status: "dated", days, window });
      expect(full({ postedAt: daysAgo(days) }).window, `${days} days`).toBe(window);
    }
    expect(postingAge(daysAgo(121), NOW, TZ)).toEqual({ status: "too_old", days: 121 });
    const old = full({ postedAt: daysAgo(121) });
    expect(old.verdict).toBe("reject");
    expect(old.reasons.join()).toMatch(/121 days ago \(limit 120\)/);
    expect(full({ postedAt: daysAgo(400) }).verdict).toBe("reject");
  });

  it("an undated or unreliable date is never treated as new: uncertain, in no window", () => {
    for (const postedAt of [undefined, "", "not a date", daysAgo(-5)]) {
      const e = full({ postedAt });
      expect(e.verdict, String(postedAt)).toBe("uncertain");
      expect(e.window).toBeNull();
      expect(e.reasons.join()).toMatch(/not treated as new/);
    }
  });

  it("uses calendar days in the app's time zone, not UTC", () => {
    // 1 Nov 00:30 IST is still 31 Oct in UTC; the job was posted 24 Oct 23:30 IST (= 24 Oct 18:00 UTC).
    const now = Date.UTC(2026, 9, 31, 19, 0);
    const posted = "2026-10-24T18:00:00Z";
    expect(postingAge(posted, now, "Asia/Kolkata")).toEqual({ status: "dated", days: 8, window: 2 });
    expect(postingAge(posted, now, "UTC")).toEqual({ status: "dated", days: 7, window: 1 });
    // a few hours in the "future" (same local day / clock skew) is today
    expect(postingAge(new Date(NOW + 3 * 3_600_000).toISOString(), NOW, TZ)).toEqual({ status: "dated", days: 0, window: 1 });
  });

  it("recency is not applied without a context (callers that do not know the date)", () => {
    expect(evaluateJob(base({ postedAt: undefined }), "full_time").window).toBeNull();
    expect(evaluateJob(base({ postedAt: undefined }), "full_time").verdict).toBe("qualifies");
  });
});
