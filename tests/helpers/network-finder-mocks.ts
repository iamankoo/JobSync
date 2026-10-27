import type { MemberId } from "@/config/members";
import { ProviderError } from "@/lib/network-finder/errors";
import { PoliteFetcher } from "@/lib/network-finder/http/polite-fetch";
import type { BatchNotifier, DraftStepDeps } from "@/lib/network-finder/pipeline";
import type { ApolloCallContext, CompanySource, ContactProvider, DiscoverQuery, ExtractedPerson, JobSearchQuery, JobSource, PeopleExtractor } from "@/lib/network-finder/providers/types";
import type { CompanyCandidate, CompanySourceId, EnrichedPerson, JobCandidate, PersonCandidate, QualifiedCompany } from "@/lib/network-finder/types";

// ---- the public web (MOCK) ------------------------------------------------------------------------------

export interface MockRoute {
  status?: number;
  body?: string;
  type?: string;
  headers?: Record<string, string>;
}

/** A fake public web: exact URL → response; anything else 404. Records every request and its headers. */
export function mockWeb(routes: Record<string, MockRoute | string>) {
  const requests: { url: string; headers: Record<string, string>; credentials?: RequestCredentials }[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    requests.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, credentials: init?.credentials });
    const r = routes[url];
    if (r === undefined) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    const route = typeof r === "string" ? { body: r } : r;
    return new Response(route.body ?? "", { status: route.status ?? 200, headers: { "content-type": route.type ?? (url.endsWith(".txt") ? "text/plain" : "text/html; charset=utf-8"), ...route.headers } });
  };
  return { fetchFn, requests, routes };
}

/** A polite fetcher on the fake web that never really waits. */
export function testFetcher(fetchFn: (url: string, init?: RequestInit) => Promise<Response>, now: () => number = Date.now) {
  return new PoliteFetcher(fetchFn, async () => undefined, now, 0);
}

export interface TeamMember {
  name: string;
  title: string;
  email?: string;
  linkedin?: string;
  phone?: string;
}

/** Homepage linking to /team, and the team page listing people (synthetic). */
export function companySite(domain: string, team: TeamMember[], extra: Record<string, MockRoute | string> = {}): Record<string, MockRoute | string> {
  const people = team
    .map((p) => `<div class="person"><h3>${p.name}</h3><p>${p.title.replace(/&/g, "&amp;")}</p>${p.phone ? `<p>Tel: ${p.phone}</p>` : ""}${p.email ? `<a href="mailto:${p.email}">Email</a>` : ""}${p.linkedin ? `<a href="${p.linkedin}" aria-label="${p.name} on LinkedIn"></a>` : ""}</div>`)
    .join("");
  return {
    [`https://${domain}/`]: `<html><body><nav><a href="/team">Our team</a><a href="/pricing">Pricing</a></nav><h1>${domain}</h1><p>Contact: hello@${domain}</p></body></html>`,
    [`https://${domain}/team`]: `<html><body><h1>Meet the team</h1>${people}</body></html>`,
    ...extra,
  };
}

/** Stands in for Nemotron: reads "name / title" pairs off the team page (plus any `extra` it is told to invent). */
export class MockExtractor implements PeopleExtractor {
  readonly id = "mock-extractor";
  calls = 0;
  extra: ExtractedPerson[] = [];
  async extractPeople({ pages }: { companyName: string; pages: readonly { url: string; text: string; links: { href: string; text: string }[] }[] }) {
    this.calls += 1;
    const out: ExtractedPerson[] = [];
    for (const p of pages) {
      const lines = p.text.split("\n");
      for (let i = 0; i + 1 < lines.length; i++) {
        if (!/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(lines[i])) continue;
        const name = lines[i];
        const title = lines[i + 1];
        const mail = p.links.find((l) => l.href.startsWith("mailto:") && l.href.includes(name.split(" ")[0].toLowerCase()));
        const li = p.links.find((l) => l.href.includes("linkedin.com/in/") && l.text.startsWith(name));
        const phone = lines[i + 2]?.startsWith("Tel: ") ? lines[i + 2].slice(5) : undefined;
        out.push({ name, title, pageUrl: p.url, ...(mail ? { email: mail.href.slice(7) } : {}), ...(li ? { linkedinUrl: li.href } : {}), ...(phone ? { phone } : {}) });
      }
    }
    return [...out, ...this.extra];
  }
}

/** Three private fake mailboxes. Only create is possible — there is no send at all. */
export class MockMailboxes implements DraftStepDeps {
  drafts: { memberId: MemberId; to?: string; subject: string; body: string; id: string }[] = [];
  connected = new Set<MemberId>(["anni", "lukky", "rishii"]);
  failFor = new Set<MemberId>();
  private entries = new Map<string, { status: string }>();
  rows: { draftKey: string; memberId: MemberId; status: string; itemId: string; gmailDraftId: string }[] = [];
  createDraft = async (memberId: MemberId, msg: { to?: string; subject: string; body: string }) => {
    if (this.failFor.has(memberId)) return { status: "failed" as const, reason: "Gmail unavailable" };
    const id = `draft-${memberId}-${this.drafts.length + 1}`;
    this.drafts.push({ memberId, ...msg, id });
    return { status: "created" as const, draftId: id, threadId: `thread-${id}` };
  };
  isConnected = async (m: MemberId) => this.connected.has(m);
  ledger = {
    get: async (key: string) => this.entries.get(key),
    record: async (e: { draftKey: string; memberId: MemberId; itemId: string; gmailDraftId: string; status: string }) => {
      this.entries.set(e.draftKey, { status: e.status });
      this.rows.push({ draftKey: e.draftKey, memberId: e.memberId, status: e.status, itemId: e.itemId, gmailDraftId: e.gmailDraftId });
    },
  };
  of(m: MemberId) {
    return this.drafts.filter((d) => d.memberId === m);
  }
}

export class MockNotifier implements BatchNotifier {
  sent: { title: string; body: string; tag: string }[] = [];
  async notifyTeam(m: { title: string; body: string; tag: string }) {
    this.sent.push(m);
  }
}

/** MOCK providers for tests only. All data here is synthetic (example.test domains). */

export function mockCompany(n: number, over: Partial<CompanyCandidate> = {}): CompanyCandidate {
  return {
    source: "yc", sourceId: `yc-${n}`, sourceUrl: `https://directory.example.test/companies/${n}`, name: `Mock Startup ${n}`,
    website: `https://mock${n}.example.test`, employeeCount: 12, countryCode: "US", remoteFriendly: true, hiring: true,
    description: "Building tools. Hiring new grad engineers.", ...over,
  };
}

export class MockCompanySource implements CompanySource {
  calls: DiscoverQuery[] = [];
  failWith: ProviderError | null = null;
  constructor(readonly id: CompanySourceId, public companies: CompanyCandidate[]) {}
  async discover(query: DiscoverQuery) {
    this.calls.push(query);
    if (this.failWith) throw this.failWith;
    const start = Number(query.cursor ?? 0);
    const page = this.companies.slice(start, start + query.limit);
    const next = start + page.length;
    return { companies: page, ...(next < this.companies.length ? { nextCursor: String(next) } : {}) };
  }
}

export interface MockPerson {
  name: string;
  title: string;
  linkedin?: string;
  /** Email the provider returns on enrichment. */
  email?: string;
  verified?: boolean;
}

/** Synthetic people per company domain: three useful people plus noise by default. */
export function defaultPeople(domain: string): MockPerson[] {
  const slug = domain.split(".")[0];
  return [
    { name: `Riya Talent ${slug}`, title: "Technical Recruiter", linkedin: `https://www.linkedin.com/in/riya-${slug}`, email: `riya@${domain}`, verified: true },
    { name: `Sam Founder ${slug}`, title: "Co-Founder & CEO", linkedin: `https://www.linkedin.com/in/sam-${slug}`, email: `sam@${domain}`, verified: true },
    { name: `Alex Manager ${slug}`, title: "Engineering Manager", linkedin: `https://www.linkedin.com/in/alex-${slug}`, email: `alex@${domain}`, verified: false },
    { name: `Jo Engineer ${slug}`, title: "Software Engineer", linkedin: `https://www.linkedin.com/in/jo-${slug}` },
    { name: `Pat Sales ${slug}`, title: "Account Executive", linkedin: `https://www.linkedin.com/in/pat-${slug}`, email: `pat@${domain}` },
  ];
}

/**
 * Mock Apollo. Records every call with the account key used. `failures` lets a test make a given key
 * rate-limited / out of credits, so the pool's rotation and pausing can be checked.
 */
export class MockApollo implements ContactProvider {
  readonly id = "apollo";
  calls: { op: "search" | "enrich"; apiKey: string; who: string }[] = [];
  failures = new Map<string, ProviderError>();
  people = new Map<string, MockPerson[]>();

  private check(ctx: ApolloCallContext) {
    const f = this.failures.get(ctx.apiKey);
    if (f) throw f;
  }

  async searchPeople(company: QualifiedCompany, options: { limit: number }, ctx: ApolloCallContext): Promise<PersonCandidate[]> {
    this.calls.push({ op: "search", apiKey: ctx.apiKey, who: company.key });
    this.check(ctx);
    const domain = company.domain ?? "unknown.example.test";
    const list = this.people.get(domain) ?? defaultPeople(domain);
    // Search returns names, titles and profile URLs only; emails come from enrichment.
    return list.slice(0, options.limit).map((p, i) => ({
      provider: "apollo", providerId: `${domain}-${i}`, name: p.name, title: p.title, companyName: company.name, companyDomain: domain,
      ...(p.linkedin ? { linkedinUrl: p.linkedin } : {}),
    }));
  }

  async enrichPerson(person: PersonCandidate, ctx: ApolloCallContext): Promise<EnrichedPerson> {
    this.calls.push({ op: "enrich", apiKey: ctx.apiKey, who: person.name });
    this.check(ctx);
    const src = (this.people.get(person.companyDomain ?? "") ?? defaultPeople(person.companyDomain ?? "")).find((p) => p.name === person.name);
    return { ...person, ...(src?.email ? { email: src.email } : {}), emailStatus: src?.email ? (src.verified ? "verified" : "unverified") : "unavailable" };
  }

  enrichCalls() {
    return this.calls.filter((c) => c.op === "enrich");
  }
}

export function mockJob(companyName: string, n: number, over: Partial<JobCandidate> = {}): JobCandidate {
  return { source: "mock-careers", companyName, title: "Software Engineer, New Grad", url: `https://careers.example.test/${encodeURIComponent(companyName)}/${n}`, remote: true, location: "Remote (US)", ...over };
}

export class MockJobSource implements JobSource {
  readonly id = "mock-careers";
  byCompany = new Map<string, JobCandidate[]>();
  searchResults: JobCandidate[] = [];
  failWith: ProviderError | null = null;
  searches: JobSearchQuery[] = [];
  async findCompanyJobs(company: QualifiedCompany) {
    if (this.failWith) throw this.failWith;
    return (this.byCompany.get(company.key) ?? []).map((j) => ({ ...j }));
  }
  async searchJobs(query: JobSearchQuery) {
    this.searches.push(query);
    if (this.failWith) throw this.failWith;
    return this.searchResults.filter((j) => (query.employment === "internship" ? /intern/i.test(j.title) : !/intern/i.test(j.title))).map((j) => ({ ...j }));
  }
}
