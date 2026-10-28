import { describe, expect, it } from "vitest";
import { ApolloPool, InMemoryApolloUsageStore, loadApolloAccounts } from "@/lib/network-finder/apollo-pool";
import { loadNetworkFinderConfig } from "@/lib/network-finder/config";
import { classifyPersona, rankPeople } from "@/lib/network-finder/contacts";
import { companyKey, ConnectionIndex, JobIndex, normalizeCompanyName, normalizeProfileUrl } from "@/lib/network-finder/dedupe";
import { ApolloPoolExhausted, ProviderError } from "@/lib/network-finder/errors";
import { toConnectionInput, toJobInput } from "@/lib/network-finder/mapping";
import { apolloProvider, careersJobSource, wellfoundSource, ycSource } from "@/lib/network-finder/providers/unconnected";
import { qualifyCompany, selectCompanies } from "@/lib/network-finder/qualify";
import { backoffDelay, InMemoryQueue } from "@/lib/network-finder/queue";
import { classifyEmployment, matchRole } from "@/lib/network-finder/roles";
import { activeWindow, DAILY_TARGET, InMemoryBatchLedger } from "@/lib/network-finder/scheduler";
import type { EnrichedPerson, QualifiedCompany } from "@/lib/network-finder/types";
import { createConnectionSchema } from "@/lib/validation/connections";
import { createJobSchema } from "@/lib/validation/jobs";
import type { Connection } from "@/types/domain";
import { mockCompany } from "../helpers/network-finder-mocks";

const qualified = (over: Parameters<typeof mockCompany>[1] = {}, n = 1): QualifiedCompany => {
  const q = qualifyCompany(mockCompany(n, over));
  if (!q.qualified) throw new Error(q.reason);
  return q.company;
};

describe("role relevance (reference profiles, not exact titles)", () => {
  it.each([
    ["Data Analyst", true], ["Product Analyst", true], ["Analytics Engineer", true], ["Junior Data Engineer", true],
    ["Machine Learning Engineer", true], ["AI Engineer", true], ["Applied AI Engineer", true], ["LLM Engineer", true],
    ["Python Developer", true], ["Backend Engineer (Node.js)", true], ["React Developer", true], ["Frontend Engineer", true],
    ["Full-Stack Engineer", true], ["MERN Stack Developer", true], ["Software Development Engineer I", true],
    ["Software Engineer, New Grad", true], ["Software Engineering Intern", true], ["Engineering Intern", true], ["iOS Developer", true], ["Flutter App Developer", true], ["Member of Technical Staff", true],
    ["Senior Software Engineer", false], ["Staff Data Engineer", false], ["Engineering Manager", false], ["Head of Data", false],
    ["Mechanical Engineer", false], ["Sales Engineer", false], ["Account Executive", false], ["Marketing Manager", false], ["", false],
  ])("%s → relevant=%s", (title, relevant) => {
    expect(matchRole(title).relevant).toBe(relevant);
  });

  it("scores named, early-career profiles above a generic title", () => {
    expect(matchRole("Junior Data Engineer").score).toBeGreaterThan(matchRole("Engineer").score);
    expect(matchRole("AI Engineer Intern").score).toBeGreaterThan(matchRole("AI Engineer").score);
  });

  it("classifies internship vs full-time (the source's own statement wins)", () => {
    expect(classifyEmployment("Software Engineering Intern")).toBe("internship");
    expect(classifyEmployment("Data Analyst Co-op")).toBe("internship");
    expect(classifyEmployment("Backend Engineer")).toBe("full_time");
    expect(classifyEmployment("Frontend Contractor")).toBe("contract");
    expect(classifyEmployment("Backend Engineer", "internship")).toBe("internship");
  });
});

describe("company qualification", () => {
  it("assigns the smallest size tier and the region group", () => {
    expect(qualified({ employeeCount: 8 }).sizeTier).toBe(25);
    expect(qualified({ employeeCount: 60 }).sizeTier).toBe(100);
    expect(qualified({ employeeCount: 250 }).sizeTier).toBe(250);
    expect(qualified({ countryCode: "US" }).regionGroup).toBe("us");
    expect(qualified({ countryCode: "uk" })).toMatchObject({ country: "GB", regionGroup: "international" });
    for (const cc of ["SG", "CA", "DE", "AE", "AU", "FR", "IT", "PL"]) expect(qualified({ countryCode: cc }).regionGroup).toBe("international");
  });

  it("rejects what it cannot verify or what is out of scope, instead of guessing", () => {
    expect(qualifyCompany(mockCompany(1, { employeeCount: 251 }))).toEqual({ qualified: false, reason: "too large (251 employees)" });
    expect(qualifyCompany(mockCompany(1, { employeeCount: undefined }))).toEqual({ qualified: false, reason: "employee count unknown" });
    expect(qualifyCompany(mockCompany(1, { countryCode: "BR" }))).toEqual({ qualified: false, reason: "country BR is not targeted" });
    expect(qualifyCompany(mockCompany(1, { countryCode: undefined }))).toEqual({ qualified: false, reason: "country unknown" });
  });

  it("prefers remote, hiring, fresher-friendly companies and records why", () => {
    const strong = qualified({ remoteFriendly: true, hiring: true, description: "We hire interns and new grads" });
    const weak = qualified({ remoteFriendly: false, hiring: false, description: "Enterprise software" });
    expect(strong.score).toBeGreaterThan(weak.score);
    expect(strong.reasons).toEqual(expect.arrayContaining(["remote-friendly", "hiring", "fresher-friendly signals"]));
  });

  it("selects ~70% US / ~30% international, smaller tiers first, and fills a shortfall from the other group", () => {
    const us = Array.from({ length: 20 }, (_, i) => qualified({ countryCode: "US", employeeCount: i < 10 ? 200 : 10 }, i));
    const intl = Array.from({ length: 20 }, (_, i) => qualified({ countryCode: "DE", employeeCount: 15 }, 100 + i));
    const picked = selectCompanies([...us, ...intl], 10);
    expect(picked.filter((c) => c.regionGroup === "us")).toHaveLength(7);
    expect(picked.filter((c) => c.regionGroup === "international")).toHaveLength(3);
    expect(picked.filter((c) => c.regionGroup === "us").every((c) => c.sizeTier === 25)).toBe(true); // 1–25 before 1–250
    const fewIntl = selectCompanies([...us, intl[0]], 10);
    expect(fewIntl).toHaveLength(10);
    expect(fewIntl.filter((c) => c.regionGroup === "international")).toHaveLength(1);
  });

  it("never selects the same company twice", () => {
    const a = qualified({}, 1);
    expect(selectCompanies([a, { ...a }, qualified({}, 2)], 10)).toHaveLength(2);
  });
});

describe("contact ranking", () => {
  it.each([
    ["Technical Recruiter", "recruiter"], ["Head of Talent", "recruiter"], ["Talent Acquisition Partner", "recruiter"], ["People Operations", "recruiter"],
    ["Engineering Manager", "hiring_manager"], ["Head of Engineering", "hiring_manager"], ["VP Engineering", "hiring_manager"],
    ["Co-Founder & CEO", "leader"], ["CTO", "leader"], ["Founder", "leader"],
    ["Software Engineer", "referrer"], ["Senior Data Engineer", "referrer"],
    ["Account Executive", null], ["Office Manager", null],
  ])("%s → %s", (title, persona) => {
    expect(classifyPersona(title)).toBe(persona);
  });

  it("orders recruiter → hiring manager → leader → referrer, prefers reachable people, and drops the unreachable", () => {
    const p = (name: string, title: string, extra: Partial<EnrichedPerson> = {}): EnrichedPerson => ({ provider: "apollo", name, title, companyName: "X", emailStatus: "unavailable", ...extra });
    const ranked = rankPeople([
      p("Eng", "Software Engineer", { email: "e@x.test", emailStatus: "verified" }),
      p("CEO", "CEO", { linkedinUrl: "https://linkedin.com/in/ceo" }),
      p("Rec", "Recruiter", { email: "r@x.test", emailStatus: "verified" }),
      p("Ghost", "Recruiter"), // no email, no profile
      p("EM", "Engineering Manager", { email: "m@x.test", emailStatus: "unverified" }),
    ]);
    expect(ranked.map((r) => r.name)).toEqual(["Rec", "EM", "CEO"]);
  });
});

describe("de-duplication", () => {
  const existing = [
    { connectionId: "conn_1", memberId: "lukky", name: "Priya Sharma", company: "Acme, Inc.", email: "Priya@Acme.test", profileUrl: "https://www.linkedin.com/in/Priya-S/", status: "Not Connected", createdAt: "", updatedAt: "" },
  ] as unknown as Connection[];

  it("recognises a known person by email, then profile URL, then name + company", () => {
    const idx = ConnectionIndex.from(existing);
    expect(idx.duplicateOf({ name: "Someone Else", companyName: "Other", email: " priya@acme.test " })).toBe("email");
    expect(idx.duplicateOf({ name: "P. Sharma", companyName: "Other", linkedinUrl: "https://linkedin.com/in/priya-s?trk=abc" })).toBe("profile_url");
    expect(idx.duplicateOf({ name: "priya  sharma", companyName: "ACME" })).toBe("name_and_company");
    expect(idx.duplicateOf({ name: "Priya Sharma", companyName: "Globex" })).toBeNull();
    idx.add({ name: "New Person", companyName: "Globex", email: "new@globex.test" });
    expect(idx.duplicateOf({ name: "x", companyName: "y", email: "NEW@globex.test" })).toBe("email");
  });

  it("normalises company names and keys companies by domain, then name", () => {
    expect(normalizeCompanyName("Acme, Inc.")).toBe("acme");
    expect(normalizeCompanyName("Café Labs GmbH")).toBe("cafe labs");
    expect(companyKey({ name: "Acme", website: "https://www.Acme.test/about" })).toBe("domain:acme.test");
    expect(companyKey({ name: "Acme Inc", website: "acme.test" })).toBe("domain:acme.test");
    expect(companyKey({ name: "Acme Inc." })).toBe("name:acme");
    expect(normalizeProfileUrl("https://in.linkedin.com/in/Foo/")).toBe("linkedin.com/in/foo");
  });

  it("recognises a known job by normalised URL or by company + title", () => {
    const idx = JobIndex.from([{ jobUrl: "https://jobs.acme.test/1?utm_source=x", company: "Acme Inc", jobRole: "Data Analyst" }] as never);
    expect(idx.duplicateOf({ url: "http://www.jobs.acme.test/1/", companyName: "Z", title: "Q" })).toBe("url");
    expect(idx.duplicateOf({ url: "https://other.test/9", companyName: "acme", title: "data analyst" })).toBe("company_and_title");
    expect(idx.duplicateOf({ url: "https://other.test/9", companyName: "acme", title: "Data Engineer" })).toBeNull();
  });
});

describe("Apollo account pool", () => {
  const env = (n: number, extra: Record<string, string> = {}) =>
    ({ ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`APOLLO_API_KEY_${i + 1}`, `test-key-${i + 1}`])), APOLLO_DAILY_LIMIT: "3", ...extra }) as unknown as NodeJS.ProcessEnv;

  it("loads up to 10 accounts from the environment, with per-account limits, skipping empty slots", () => {
    const accounts = loadApolloAccounts({ ...env(12), APOLLO_API_KEY_4: " ", APOLLO_DAILY_LIMIT_2: "7" } as unknown as NodeJS.ProcessEnv);
    expect(accounts.map((a) => a.id)).toEqual(["apollo-1", "apollo-2", "apollo-3", "apollo-5", "apollo-6", "apollo-7", "apollo-8", "apollo-9", "apollo-10"]);
    expect(accounts.find((a) => a.id === "apollo-2")!.dailyLimit).toBe(7);
    expect(loadApolloAccounts({ APOLLO_API_KEY_1: "k" } as unknown as NodeJS.ProcessEnv)[0].dailyLimit).toBe(0); // no limit set = unusable, never unlimited
  });

  it("uses account 1 first, moves to account 2 only when 1 is used up, and never exceeds a daily limit", async () => {
    let t = Date.UTC(2026, 9, 27, 5);
    const pool = new ApolloPool(loadApolloAccounts(env(2, { APOLLO_PER_MINUTE_LIMIT: "100" })), new InMemoryApolloUsageStore(), () => t);
    const used: string[] = [];
    for (let i = 0; i < 6; i++) await pool.call(1, async (_ctx, id) => void used.push(id));
    expect(used).toEqual(["apollo-1", "apollo-1", "apollo-1", "apollo-2", "apollo-2", "apollo-2"]);
    await expect(pool.call(1, async () => "x")).rejects.toBeInstanceOf(ApolloPoolExhausted);
    t = Date.UTC(2026, 9, 28, 0, 0, 1); // new UTC day: fresh quota
    await expect(pool.call(1, async () => "ok")).resolves.toBe("ok");
  });

  it("respects the per-minute limit", async () => {
    let t = Date.UTC(2026, 9, 27, 5);
    const pool = new ApolloPool(loadApolloAccounts(env(1, { APOLLO_DAILY_LIMIT: "100", APOLLO_PER_MINUTE_LIMIT: "2" })), new InMemoryApolloUsageStore(), () => t);
    await pool.call(1, async () => 1);
    await pool.call(1, async () => 1);
    const err = await pool.call(1, async () => 1).catch((e) => e);
    expect(err).toBeInstanceOf(ApolloPoolExhausted);
    expect(err.resumeAt).toBe(Date.UTC(2026, 9, 27, 5, 1));
    t += 60_000;
    await expect(pool.call(1, async () => "ok")).resolves.toBe("ok");
  });

  it("pauses a rate-limited or out-of-credit account and moves on to the next; reports the earliest resume time", async () => {
    const t = Date.UTC(2026, 9, 27, 5);
    const store = new InMemoryApolloUsageStore();
    const pool = new ApolloPool(loadApolloAccounts(env(3, { APOLLO_DAILY_LIMIT: "50", APOLLO_PER_MINUTE_LIMIT: "50" })), store, () => t);
    const keys: string[] = [];
    const res = await pool.call(1, async (ctx) => {
      keys.push(ctx.apiKey);
      if (ctx.apiKey === "test-key-1") throw new ProviderError("apollo", "rate_limited", "slow down", t + 30_000);
      if (ctx.apiKey === "test-key-2") throw new ProviderError("apollo", "quota_exhausted", "no credits");
      return "done";
    });
    expect(res).toBe("done");
    expect(keys).toEqual(["test-key-1", "test-key-2", "test-key-3"]);
    const status = await pool.status();
    expect(status.find((s) => s.id === "apollo-1")).toMatchObject({ pauseReason: "rate_limited", pausedUntil: t + 30_000 });
    // No reset time from Apollo (its windows are not clock-aligned): probe again in an hour.
    expect(status.find((s) => s.id === "apollo-2")).toMatchObject({ pauseReason: "quota_exhausted", pausedUntil: t + 3_600_000 });
    expect(JSON.stringify(status)).not.toContain("test-key"); // never exposes keys
  });

  it("lets non-account errors through without pausing anything", async () => {
    const pool = new ApolloPool(loadApolloAccounts(env(1, { APOLLO_DAILY_LIMIT: "5" })), new InMemoryApolloUsageStore());
    await expect(pool.call(1, async () => { throw new ProviderError("apollo", "invalid_response", "bad"); })).rejects.toMatchObject({ kind: "invalid_response" });
    expect((await pool.status())[0].pausedUntil).toBeUndefined();
  });

  it("with no accounts configured, it is exhausted (never calls anything)", async () => {
    const pool = new ApolloPool([], new InMemoryApolloUsageStore());
    let called = false;
    await expect(pool.call(1, async () => { called = true; })).rejects.toBeInstanceOf(ApolloPoolExhausted);
    expect(called).toBe(false);
  });
});

describe("work queue", () => {
  it("is idempotent, pauses and auto-resumes, retries with backoff, and gives up after max attempts", async () => {
    const q = new InMemoryQueue<{ n: number }>(3);
    expect(await q.enqueue("company:a", { n: 1 }, 0)).toBe(true);
    expect(await q.enqueue("company:a", { n: 2 }, 0)).toBe(false);
    await q.pause(1000, "apollo_exhausted");
    expect(await q.claim(500)).toBeNull();
    expect(await q.state(500)).toMatchObject({ paused: true, pausedUntil: 1000, reason: "apollo_exhausted", pending: 1 });
    const item = (await q.claim(1000))!;
    expect(item.payload.n).toBe(1);
    expect(await q.claim(1000)).toBeNull(); // leased
    expect(await q.retry(item.id, 1000, 60_000, "boom")).toBe("pending");
    expect(await q.claim(2000)).toBeNull();
    await q.claim(61_000);
    await q.retry(item.id, 61_000, 1, "boom");
    await q.claim(70_000);
    expect(await q.retry(item.id, 70_000, 1, "boom")).toBe("failed");
    expect((await q.get(item.id))!.attempts).toBe(3);
  });

  it("re-offers an item whose lease expired (a crashed run) and does not count waits that are not the item's fault", async () => {
    const q = new InMemoryQueue<number>();
    await q.enqueue("x", 1, 0);
    await q.claim(0);
    expect(await q.claim(60_000)).toBeNull();
    expect(await q.claim(5 * 60_000)).not.toBeNull();
    await q.retry("x", 0, 0, "apollo_exhausted", { countAttempt: false });
    expect((await q.get("x"))!.attempts).toBe(0);
  });

  it("backs off exponentially up to an hour", () => {
    expect([1, 2, 3, 10].map(backoffDelay)).toEqual([60_000, 120_000, 240_000, 3_600_000]);
  });
});

describe("batch scheduler", () => {
  const ist = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 27, h, m) - 5.5 * 3_600_000); // local IST time on 27 Oct

  it("has five 2-hour windows of 10 = 50 a day, in local time", () => {
    expect(DAILY_TARGET).toBe(50);
    expect(activeWindow(ist(2, 0), "Asia/Kolkata")).toEqual({ index: 0, date: "2026-10-27", key: "2026-10-27#0" });
    expect(activeWindow(ist(3, 59), "Asia/Kolkata")?.index).toBe(0);
    expect(activeWindow(ist(4, 0), "Asia/Kolkata")).toBeNull();
    expect(activeWindow(ist(7, 30), "Asia/Kolkata")?.index).toBe(1);
    expect(activeWindow(ist(11), "Asia/Kolkata")?.index).toBe(2);
    expect(activeWindow(ist(15), "Asia/Kolkata")?.index).toBe(3);
    expect(activeWindow(ist(19, 59), "Asia/Kolkata")?.index).toBe(4);
    expect(activeWindow(ist(20), "Asia/Kolkata")).toBeNull();
    expect(activeWindow(ist(0, 30), "Asia/Kolkata")).toBeNull();
  });

  it("counts completed work per key", async () => {
    const l = new InMemoryBatchLedger();
    expect(await l.get("k")).toBe(0);
    expect(await l.add("k", 2)).toBe(2);
    expect(await l.add("k", 1)).toBe(3);
  });
});

describe("config and mapping", () => {
  it("is off by default; owners default to Anni and only accept real members", () => {
    const c = loadNetworkFinderConfig({} as NodeJS.ProcessEnv);
    expect(c).toMatchObject({ enabled: false, contactOwner: "anni", jobOwner: "anni", batchSize: 10, peoplePerCompany: 3, dailyInternships: 15, dailyFullTime: 15 });
    expect(loadNetworkFinderConfig({ NETWORK_FINDER_ENABLED: "true", NETWORK_FINDER_CONTACT_OWNER: "lukky", NETWORK_FINDER_JOB_OWNER: "mallory" } as unknown as NodeJS.ProcessEnv)).toMatchObject({ enabled: true, contactOwner: "lukky", jobOwner: "anni" });
  });

  it("maps a person into input the existing Connections schema accepts (no message; source in notes)", () => {
    const company = qualified({}, 7);
    const input = toConnectionInput({ provider: "apollo", name: "Riya Talent", title: "Technical Recruiter", companyName: company.name, email: "riya@mock7.example.test", emailStatus: "verified", linkedinUrl: "https://www.linkedin.com/in/riya", persona: "recruiter" }, company, "2026-10-27");
    const parsed = createConnectionSchema.parse(input);
    expect(parsed).toMatchObject({ name: "Riya Talent", company: "Mock Startup 7", role: "Technical Recruiter", email: "riya@mock7.example.test", profileUrl: "https://www.linkedin.com/in/riya", otherUrl: "https://mock7.example.test", status: "Not Connected" });
    expect(parsed.message).toBeUndefined();
    expect(parsed.notes).toContain("Source: Network Finder — YC");
    expect(parsed.notes).toContain("Discovered: 2026-10-27");
    expect(parsed.notes).toContain("Recruiter / Talent");
  });

  it("drops an invalid email or URL rather than failing the whole contact", () => {
    const input = toConnectionInput({ provider: "apollo", name: "X", title: "CEO", companyName: "Y", email: "not-an-email", emailStatus: "unverified", linkedinUrl: "javascript:alert(1)", persona: "leader" }, qualified({ website: undefined }, 8), "2026-10-27");
    expect(input.email).toBeUndefined();
    expect(input.profileUrl).toBeUndefined();
    expect(() => createConnectionSchema.parse(input)).not.toThrow();
  });

  it("maps a posting into input the existing Jobs schema accepts", () => {
    const parsed = createJobSchema.parse(toJobInput({ source: "greenhouse", companyName: "Mock", title: "Data Analyst Intern", url: "https://jobs.example.test/1", remote: true }, "2026-10-27"));
    expect(parsed).toMatchObject({ company: "Mock", jobRole: "Data Analyst Intern", jobType: "Internship", workMode: "Remote", location: "Remote", jobUrl: "https://jobs.example.test/1" });
    expect(parsed.description).toContain("Found by Network Finder via greenhouse on 2026-10-27.");
    expect(createJobSchema.parse(toJobInput({ source: "s", companyName: "M", title: "Backend Engineer", url: "https://j.example.test/2" }, "2026-10-27"))).toMatchObject({ jobType: "Full-time", location: "Not specified" });
  });
});

describe("real adapters are not connected in this milestone", () => {
  it("every one refuses with not_configured instead of returning data", async () => {
    const company = qualified();
    await expect(ycSource.discover({ maxEmployees: 25, countries: ["US"], limit: 5 })).rejects.toMatchObject({ kind: "not_configured", provider: "yc" });
    await expect(wellfoundSource.discover({ maxEmployees: 25, countries: ["US"], limit: 5 })).rejects.toMatchObject({ kind: "not_configured", provider: "wellfound" });
    await expect(apolloProvider.searchPeople(company, { limit: 3 }, { apiKey: "k" })).rejects.toMatchObject({ kind: "not_configured" });
    await expect(careersJobSource.findCompanyJobs(company)).rejects.toMatchObject({ kind: "not_configured" });
  });
});
