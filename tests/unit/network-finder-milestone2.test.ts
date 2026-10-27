/**
 * Milestone 2 additions: free qualification facts from the company's own pages (rules + a checked model answer),
 * the Apollo → website enrichment chain, account-1-only Apollo, member signatures, and the counts-only cron
 * response. Synthetic data only (example.test domains); no network.
 */
import { describe, expect, it } from "vitest";
import { enabledApolloAccounts } from "@/lib/network-finder/apollo-pool";
import { loadNetworkFinderConfig } from "@/lib/network-finder/config";
import { ProviderError } from "@/lib/network-finder/errors";
import { createCompanyFactsFinder, verifyFacts, type CompanyFactsExtractor } from "@/lib/network-finder/providers/company-facts";
import { createNemotronCompanyFactsExtractor } from "@/lib/network-finder/providers/nemotron";
import { qualifyCompany } from "@/lib/network-finder/qualify";
import { chainEnrichers, summarizeCycle, type CycleResult } from "@/lib/network-finder/run";
import { mockCompany, mockWeb, testFetcher } from "../helpers/network-finder-mocks";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
const page = (url: string, text: string) => ({ url, text, links: [] });

describe("verifyFacts: a model answer counts only if the page says it", () => {
  const pages = [page("https://acme.example.test/about", "Acme was founded in 2019. Today we are a team of 14 people based in Berlin, Germany.")];

  it("accepts a size and headquarters sentence that appear on the page", () => {
    expect(verifyFacts({ sizeQuote: "we are a team of 14 people", employees: 14, hqQuote: "based in Berlin, Germany" }, pages)).toEqual({
      employeeCount: 14,
      countryCode: "DE",
      source: "size stated on https://acme.example.test/about; location stated on https://acme.example.test/about",
    });
  });

  it("rejects an invented sentence, a number not in the sentence, a year, and a non-target country", () => {
    expect(verifyFacts({ sizeQuote: "we are a team of 40 people", employees: 40 }, pages)).toBeNull(); // not on the page
    expect(verifyFacts({ sizeQuote: "we are a team of 14 people", employees: 9 }, pages)).toBeNull(); // model's number not stated
    expect(verifyFacts({ sizeQuote: "Acme was founded in 2019." }, pages)).toBeNull(); // no size words; a year is no head count
    expect(verifyFacts({ hqQuote: "Tokyo" }, [page("https://x.example.test/", "Offices in Tokyo")])).toBeNull();
  });
});

describe("company facts finder (company's own pages)", () => {
  const site = (about: string) =>
    mockWeb({
      "https://acme.example.test/": '<h1>Acme</h1><a href="/about">About us</a>',
      "https://acme.example.test/about": about,
    });

  it("rules first: an explicit size sentence needs no model call", async () => {
    let calls = 0;
    const extractor: CompanyFactsExtractor = { id: "x", extractFacts: async () => (calls++, {}) };
    const web = site("<p>We are a team of 9 engineers and designers.</p>");
    const f = await createCompanyFactsFinder(testFetcher(web.fetchFn), extractor).find({ ...mockCompany(1), website: "https://acme.example.test", employeeCount: undefined, countryCode: "US" });
    expect(f).toEqual({ employeeCount: 9, source: "size stated on https://acme.example.test/about" });
    expect(calls).toBe(0);
  });

  it("Nemotron reads the size / HQ sentences; the finder keeps only what the page supports → the company qualifies", async () => {
    const web = site("<p>Our story. Small but mighty: 22 people across two offices. Headquartered in London, UK.</p>");
    const fetchFn = async () => Response.json({ choices: [{ message: { content: JSON.stringify({ sizeQuote: "Small but mighty: 22 people across two offices.", employees: 22, hqQuote: "Headquartered in London, UK." }) } }] });
    const extractor = createNemotronCompanyFactsExtractor({ apiKey: "k", model: "nvidia/test", baseUrl: "https://nim.example.test/v1" }, fetchFn);
    const c = { ...mockCompany(1), website: "https://acme.example.test", employeeCount: undefined, countryCode: undefined };
    const f = await createCompanyFactsFinder(testFetcher(web.fetchFn), extractor).find(c);
    expect(f).toMatchObject({ employeeCount: 22, countryCode: "GB" });
    const q = qualifyCompany({ ...c, employeeCount: f!.employeeCount, countryCode: f!.countryCode, factsSource: f!.source });
    expect(q.qualified && q.company.reasons).toContain("size stated on https://acme.example.test/about; location stated on https://acme.example.test/about");
  });

  it("a hallucinated answer is dropped and the company stays unqualified (nothing guessed)", async () => {
    const web = site("<p>We build developer tools.</p>");
    const extractor: CompanyFactsExtractor = { id: "x", extractFacts: async () => ({ sizeQuote: "We are 12 people", employees: 12, hqQuote: "Based in New York" }) };
    expect(await createCompanyFactsFinder(testFetcher(web.fetchFn), extractor).find({ ...mockCompany(1), website: "https://acme.example.test", employeeCount: undefined })).toBeNull();
  });
});

describe("enrichment chain: Apollo (optional) → the company's own pages", () => {
  it("an Apollo plan refusal switches Apollo off for the run; the free step still fills the gap", async () => {
    let apolloCalls = 0;
    const apollo = async () => {
      apolloCalls++;
      throw new ProviderError("apollo", "forbidden", "not in plan");
    };
    const facts = { find: async () => ({ employeeCount: 8, countryCode: "US", source: "size stated on https://a.example.test/about" }) };
    const enrich = chainEnrichers(apollo, facts)!;
    const c = { ...mockCompany(1), employeeCount: undefined, countryCode: undefined };
    expect(await enrich(c)).toMatchObject({ employeeCount: 8, countryCode: "US", factsSource: "size stated on https://a.example.test/about" });
    await enrich(c);
    expect(apolloCalls).toBe(1);
  });

  it("Apollo's answer is used first; the website is only asked for what is still missing", async () => {
    let factsCalls = 0;
    const enrich = chainEnrichers(async () => ({ ...mockCompany(1), employeeCount: 30, countryCode: "CA" }), { find: async () => (factsCalls++, null) })!;
    expect(await enrich({ ...mockCompany(1), employeeCount: undefined, countryCode: undefined })).toMatchObject({ employeeCount: 30, countryCode: "CA" });
    expect(factsCalls).toBe(0);
  });

  it("non-Apollo errors are not swallowed (the discovery step reports them)", async () => {
    const enrich = chainEnrichers(undefined, { find: async () => { throw new ProviderError("website", "rate_limited", "slow down"); } })!;
    await expect(enrich({ ...mockCompany(1), employeeCount: undefined })).rejects.toThrow(ProviderError);
  });
});

describe("configuration", () => {
  it("Apollo: only account 1 unless APOLLO_ENABLED_ACCOUNTS lists more, even when other keys are present", () => {
    const base = { APOLLO_API_KEY_1: "key-one-xxxx", APOLLO_API_KEY_2: "key-two-xxxx", APOLLO_DAILY_LIMIT: "600" };
    expect(enabledApolloAccounts(env(base)).map((a) => a.id)).toEqual(["apollo-1"]);
    expect(enabledApolloAccounts(env({ ...base, APOLLO_ENABLED_ACCOUNTS: "1,2" })).map((a) => a.id)).toEqual(["apollo-1", "apollo-2"]);
    expect(enabledApolloAccounts(env({ ...base, APOLLO_DAILY_LIMIT: "" }))).toEqual([]); // no limit configured = never used
  });

  it("per-member profiles and signatures (\\n allowed in signatures)", () => {
    const c = loadNetworkFinderConfig(env({ NETWORK_FINDER_SIGNATURE_RISHII: "Rishii\\nlinkedin.example.test/rishii", NETWORK_FINDER_PROFILE_ANNI: "Data analyst grad" }));
    expect(c.signatures).toEqual({ rishii: "Rishii\nlinkedin.example.test/rishii" });
    expect(c.profiles).toEqual({ anni: "Data analyst grad" });
  });
});

describe("cron response", () => {
  it("returns counts only — no contact names, emails or companies", () => {
    const run: CycleResult = {
      ran: true,
      errors: [],
      batch: {
        ran: true, window: { index: 1, key: "2026-10-27#1", date: "2026-10-27" } as never, remaining: 9, failed: [],
        processed: [{ companyKey: "domain:acme.example.test", peopleFound: 2, contactsSaved: ["Riya Talent"], contactsSkipped: [{ name: "Sam Founder", reason: "x" }], jobsSaved: ["Intern"], jobsSkipped: [], warnings: [], selected: { connectionId: "c1", name: "Riya Talent", assignedTo: "anni", email: "riya@acme.example.test", emailStatus: "public" }, drafts: [{ memberId: "anni", result: "created" }] }],
      },
      dailyJobs: { internships: ["Software Intern @ Acme"], fullTime: [], warnings: [] },
    };
    const s = summarizeCycle(run);
    expect(s.batch).toMatchObject({ companiesProcessed: 1, contactsSaved: 1, selected: 1, draftsCreated: 1, jobsSaved: 1 });
    expect(JSON.stringify(s)).not.toMatch(/Riya|Sam Founder|acme|Software Intern|"Intern"/i);
  });
});
