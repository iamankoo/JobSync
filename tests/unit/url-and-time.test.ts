import { describe, expect, it } from "vitest";
import { normalizeJobUrl, parseHttpUrl } from "@/lib/utils/url";
import { dateInTimezone, isIsoDate, isIsoTimestamp, nowIso, resolveTimezone } from "@/lib/utils/time";

describe("normalizeJobUrl", () => {
  const base = normalizeJobUrl("https://jobs.example.test/jobs/results/123");

  it("treats scheme, case, www, default ports, fragments and trailing slashes as equivalent", () => {
    for (const u of [
      "http://jobs.example.test/jobs/results/123",
      "HTTPS://Jobs.Example.test/jobs/results/123/",
      "https://jobs.example.test:443/jobs/results/123#apply",
      "  https://jobs.example.test/jobs/results/123  ",
      "https://jobs.example.test//jobs//results/123",
    ]) {
      expect(normalizeJobUrl(u)).toBe(base);
    }
    expect(normalizeJobUrl("https://www.example.test/a")).toBe(normalizeJobUrl("https://example.test/a"));
  });

  it("drops tracking parameters but keeps meaningful ones, in a stable order", () => {
    expect(normalizeJobUrl("https://example.test/job?utm_source=a&gclid=1&id=7&b=2")).toBe("example.test/job?b=2&id=7");
    expect(normalizeJobUrl("https://example.test/job?id=7&b=2")).toBe(normalizeJobUrl("https://example.test/job?b=2&id=7"));
  });

  it("distinguishes genuinely different jobs", () => {
    expect(normalizeJobUrl("https://example.test/job?id=7")).not.toBe(normalizeJobUrl("https://example.test/job?id=8"));
    expect(normalizeJobUrl("https://example.test/a")).not.toBe(normalizeJobUrl("https://example.test/b"));
    expect(normalizeJobUrl("https://example.test:8443/a")).not.toBe(normalizeJobUrl("https://example.test/a"));
  });

  it("rejects non-http(s), credentials, hostnames without a dot and garbage", () => {
    for (const bad of ["", "not a url", "javascript:alert(1)", "ftp://x.com/a", "https://user:pw@x.com/a", "https://localhost/a", "https://" + "a".repeat(2100) + ".com"]) {
      expect(normalizeJobUrl(bad)).toBeNull();
      expect(parseHttpUrl(bad)).toBeNull();
    }
  });
});

describe("time helpers", () => {
  it("produces ISO 8601 UTC timestamps", () => {
    const t = nowIso(new Date("2026-10-12T08:30:00Z"));
    expect(t).toBe("2026-10-12T08:30:00.000Z");
    expect(isIsoTimestamp(t)).toBe(true);
    expect(isIsoTimestamp("2026-10-12 08:30")).toBe(false);
    expect(isIsoTimestamp("2026-13-45T00:00:00Z")).toBe(false);
  });

  it("validates real calendar dates", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-2-3")).toBe(false);
    expect(isIsoDate("12/10/2026")).toBe(false);
  });

  it("computes the activity date in the configured timezone", () => {
    const lateUtc = new Date("2026-10-12T20:00:00Z"); // 01:30 next day in IST
    expect(dateInTimezone(lateUtc, "UTC")).toBe("2026-10-12");
    expect(dateInTimezone(lateUtc, "Asia/Kolkata")).toBe("2026-10-13");
  });

  it("falls back to the default timezone for invalid values", () => {
    expect(resolveTimezone("Not/AZone")).toBe("Asia/Kolkata");
    expect(resolveTimezone(undefined)).toBe("Asia/Kolkata");
    expect(resolveTimezone("UTC")).toBe("UTC");
  });
});
