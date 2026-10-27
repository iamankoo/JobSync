/**
 * The FREE Network Finder end to end: synthetic public company pages (a fake web), a stand-in extractor,
 * fake mailboxes and notifier — saving through the REAL Connections and Jobs services into the in-memory
 * spreadsheet. No network, no real accounts, no production. Apollo is absent unless a test adds it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { createConnection } from "@/lib/google-sheets/connections-service";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { ApolloPool, InMemoryApolloUsageStore, loadApolloAccounts } from "@/lib/network-finder/apollo-pool";
import { loadNetworkFinderConfig, type NetworkFinderConfig } from "@/lib/network-finder/config";
import { countsByMember, InMemorySelectionStore, nextAssignee } from "@/lib/network-finder/distribution";
import { ProviderError } from "@/lib/network-finder/errors";
import { existingConnections, existingJobs } from "@/lib/network-finder/gateways";
import { processCompany, runBatchTick, runDailyJobSearch, runPendingDrafts, type CompanyTask, type PipelineDeps } from "@/lib/network-finder/pipeline";
import { createArbeitnowSource, createCompanyBoardSource, createRemoteOkSource } from "@/lib/network-finder/providers/job-boards";
import { createNemotronBrain } from "@/lib/network-finder/providers/nemotron";
import { createWebsiteContactFinder } from "@/lib/network-finder/providers/website-contacts";
import { qualifyCompany } from "@/lib/network-finder/qualify";
import { InMemoryQueue, LEASE_MS } from "@/lib/network-finder/queue";
import { InMemoryCompanyRegistry } from "@/lib/network-finder/registry";
import { InMemoryBatchLedger } from "@/lib/network-finder/scheduler";
import { runSentTracking } from "@/lib/network-finder/sent-tracker";
import { createSheetsStores } from "@/lib/network-finder/sheets-stores";
import type { CompanyCandidate, QualifiedCompany } from "@/lib/network-finder/types";
import { FakeSheets, googleError } from "../helpers/fake-sheets";
import { companySite, MockApollo, mockCompany, MockCompanySource, MockExtractor, mockJob, MockJobSource, MockMailboxes, MockNotifier, mockWeb, testFetcher, type MockRoute, type TeamMember } from "../helpers/network-finder-mocks";

// Connections columns: 0 ID 1 MemberID 2 Name 3 Company 4 Role 5 ProfileUrl 6 OtherUrl 7 Message 8 Notes 9 Status 10 CreatedAt 11 UpdatedAt 12 Email
let sheets: FakeSheets;
let clock: number;
/** 10:30 IST on 27 Oct 2026 = inside batch window #2. */
const IN_WINDOW = Date.UTC(2026, 9, 27, 5, 0);

beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
  clock = IN_WINDOW;
});
afterEach(() => setSheetsClientForTesting(null));

const conns = () => sheets.dataRows("Connections");
const jobs = () => sheets.dataRows("Jobs");

/** A small team page per company: a recruiter with a published email (sets the pattern), an EM with LinkedIn, a founder, and noise. */
const team = (domain: string): TeamMember[] => [
  { name: "Riya Talent", title: "Technical Recruiter", email: `riya.talent@${domain}` },
  { name: "Sam Founder", title: "Co-Founder & CEO", phone: "+1 415 555 0101" },
  { name: "Alex Manager", title: "Engineering Manager", linkedin: `https://www.linkedin.com/in/alex-${domain.split(".")[0]}` },
  { name: "Pat Sales", title: "Account Executive" },
];

function setup(options: { companies?: CompanyCandidate[]; config?: Partial<NetworkFinderConfig>; routes?: Record<string, MockRoute | string> } = {}) {
  const companies = options.companies ?? [mockCompany(1)];
  const routes: Record<string, MockRoute | string> = {};
  for (const c of companies) Object.assign(routes, companySite(new URL(c.website!).hostname, team(new URL(c.website!).hostname)));
  Object.assign(routes, options.routes ?? {});
  const web = mockWeb(routes);
  const fetcher = testFetcher(web.fetchFn, () => clock);
  const extractor = new MockExtractor();
  const mail = new MockMailboxes();
  const notifier = new MockNotifier();
  const jobSource = new MockJobSource();
  const source = new MockCompanySource("hn", companies);
  const deps: PipelineDeps = {
    config: { ...loadNetworkFinderConfig({ NETWORK_FINDER_ENABLED: "true", APP_TIMEZONE: "Asia/Kolkata" } as unknown as NodeJS.ProcessEnv), maxCompaniesPerTick: 10, ...options.config },
    sources: [source],
    contactFinders: [createWebsiteContactFinder(fetcher, extractor)],
    jobSources: [jobSource],
    queue: new InMemoryQueue<CompanyTask>(),
    registry: new InMemoryCompanyRegistry(),
    ledger: new InMemoryBatchLedger(),
    selections: new InMemorySelectionStore(),
    drafts: mail,
    notifier,
    connections: existingConnections,
    jobs: existingJobs,
    now: () => new Date(clock),
    runState: {},
  };
  return { deps, web, extractor, mail, notifier, jobSource, source, fetcher };
}

const q = (c: CompanyCandidate): QualifiedCompany => {
  const r = qualifyCompany(c);
  if (!r.qualified) throw new Error(r.reason);
  return r.company;
};

describe("free pipeline: public pages → Connections → selection → three Gmail drafts", () => {
  it("finds contacts on the company's own site, saves them as Anni (Not Connected, no message), selects one and drafts it in all three mailboxes", async () => {
    const { deps, mail, web } = setup();
    const tick = await runBatchTick(deps);
    expect(tick.ran).toBe(true);
    if (!tick.ran) return;
    const [out] = tick.processed;

    // Priority order (recruiter → hiring manager → founder); the sales person is ignored. No Apollo involved.
    expect(out.contactsSaved).toEqual(["Riya Talent", "Alex Manager", "Sam Founder"]);
    expect(conns().some((r) => r[2] === "Pat Sales")).toBe(false); // not a useful contact: never collected
    expect(web.requests.map((r) => r.url)).toEqual(["https://mock1.example.test/robots.txt", "https://mock1.example.test/", "https://mock1.example.test/team"]);

    const row = (name: string) => conns().find((r) => r[2] === name)!;
    expect(conns().every((r) => r[1] === "anni" && r[9] === "Not Connected" && r[7] === "")).toBe(true);
    // A real published email is saved as public; the others are predicted from that published pattern and labelled.
    expect(row("Riya Talent")[12]).toBe("riya.talent@mock1.example.test");
    expect(row("Riya Talent")[8]).toContain("Email: public — published on https://mock1.example.test/team");
    expect(row("Sam Founder")[12]).toBe("sam.founder@mock1.example.test");
    expect(row("Sam Founder")[8]).toContain("Email: Predicted / Unverified — VERIFY BEFORE SENDING");
    expect(row("Sam Founder")[8]).toContain("Phone: +1 415 555 0101");
    expect(row("Alex Manager")[5]).toBe("https://www.linkedin.com/in/alex-mock1");
    expect(row("Alex Manager")[8]).toContain("Predicted / Unverified");

    // Today's selection: the recruiter (best persona with an email), assigned to Anni (first of the day).
    expect(out.selected).toMatchObject({ name: "Riya Talent", assignedTo: "anni", email: "riya.talent@mock1.example.test", emailStatus: "public" });
    expect(row("Riya Talent")[8]).toContain("Assigned to: Anni");
    expect(row("Sam Founder")[8]).not.toContain("Assigned to");

    // For EVERY saved contact, one personalised draft in EACH member's own mailbox — the selected contact first.
    // Who is assigned / who owns the record does not matter. Nothing is sent.
    expect(out.drafts?.map((d) => [d.memberId, d.result])).toEqual(Array(3).fill([["anni", "created"], ["lukky", "created"], ["rishii", "created"]]).flat());
    for (const m of ["anni", "lukky", "rishii"] as const) {
      expect(mail.of(m).map((d) => d.to)).toEqual(["riya.talent@mock1.example.test", "alex.manager@mock1.example.test", "sam.founder@mock1.example.test"]);
      for (const d of mail.of(m)) expect(d.body).not.toMatch(/\[[A-Z][a-z]+\]/);
    }
    // Signed with each mailbox owner's full name.
    expect(mail.of("anni").every((d) => d.body.includes("Aniket Raj"))).toBe(true);
    expect(mail.of("lukky").every((d) => d.body.includes("Lakshya Singh"))).toBe(true);
    expect(mail.of("rishii").every((d) => d.body.includes("Rishi Raj"))).toBe(true);
    expect(row("Sam Founder")[8]).toContain("Drafts: one in each member's Gmail");
  });

  it("re-running the company (retry / next day) adds no contacts, no second selection and no second draft", async () => {
    const { deps, mail } = setup();
    const company = q(mockCompany(1));
    await processCompany(deps, company);
    const again = await processCompany(deps, company);
    expect(again.contactsSaved).toEqual([]);
    expect(conns()).toHaveLength(3);
    expect(await deps.selections!.all()).toHaveLength(1);
    expect(again.drafts?.every((d) => d.result === "already_drafted")).toBe(true);
    expect(mail.drafts).toHaveLength(9);
    expect(await runPendingDrafts(deps)).toEqual({ checked: 0, created: 0, remaining: 0 });
    expect(mail.drafts).toHaveLength(9);
  });

  it("de-duplicates against Connections a member added by hand (email match) and never touches that entry", async () => {
    const { deps } = setup();
    await createConnection("lukky", { name: "R. Talent", email: "RIYA.TALENT@mock1.example.test", status: "Messaged" });
    const out = await processCompany(deps, q(mockCompany(1)));
    expect(out.contactsSkipped).toContainEqual({ name: "Riya Talent", reason: "already in Connections (email)" });
    expect(out.contactsSaved).toEqual(["Alex Manager", "Sam Founder"]);
    // The hand-added person is not selected for outreach (not a Network Finder entry); the next best with an email is.
    expect(out.selected?.name).toBe("Alex Manager");
    expect(conns().find((r) => r[1] === "lukky")![9]).toBe("Messaged");
  });

  it("finds an unlinked /team page at its conventional address — but never one robots.txt disallows", async () => {
    const homeNoLinks = { "https://mock1.example.test/": "<h1>Mock 1</h1><p>We build things.</p>" };
    const ok = setup({ routes: homeNoLinks });
    expect((await processCompany(ok.deps, q(mockCompany(1)))).contactsSaved).toHaveLength(3);
    sheets = new FakeSheets().seedMembers();
    setSheetsClientForTesting(sheets);
    const blocked = setup({ routes: { ...homeNoLinks, "https://mock1.example.test/robots.txt": "User-agent: *\nDisallow: /team" } });
    expect((await processCompany(blocked.deps, q(mockCompany(1)))).contactsSaved).toEqual([]);
    expect(blocked.web.requests.map((r) => r.url)).not.toContain("https://mock1.example.test/team");
  });

  it("saves nothing when a page offers no reachable person, and never invents one", async () => {
    const { deps, extractor } = setup({ routes: { "https://mock1.example.test/team": "<h1>Team</h1><h3>Ghost Writer</h3><p>Head of Vibes</p>" } });
    extractor.extra = [{ name: "Invented Person", title: "Technical Recruiter", email: "invented@mock1.example.test", pageUrl: "https://mock1.example.test/team" }];
    const out = await processCompany(deps, q(mockCompany(1)));
    expect(out.contactsSaved).toEqual([]);
    expect(conns()).toHaveLength(0);
    expect(out.selected).toBeUndefined();
  });
});

describe("17 / 17 / 16 across the day's batches", () => {
  it("assigns each company's selected contact in turn — Anni, Lukky, Rishii — and every contact gets three drafts", async () => {
    const companies = Array.from({ length: 6 }, (_, i) => mockCompany(i + 1, { countryCode: "US" }));
    const { deps, mail } = setup({ companies });
    await runBatchTick(deps);
    const sel = (await deps.selections!.all()).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.companyKey.localeCompare(b.companyKey));
    expect(sel.map((s) => s.assignedTo)).toEqual(["anni", "lukky", "rishii", "anni", "lukky", "rishii"]);
    expect(sel.every((s) => s.draftedFor.length === 3)).toBe(true);
    expect(mail.drafts).toHaveLength(54); // 18 contacts × 3 mailboxes, regardless of assignment
    for (const m of ["anni", "lukky", "rishii"] as const) expect(mail.of(m)).toHaveLength(18);
    expect(conns().filter((r) => r[8].includes("Assigned to: Lukky"))).toHaveLength(2);
    expect(conns()).toHaveLength(18); // up to 3 contacts per company; only one per company is selected
  });

  it("full day plan: 50 companies' selections come out exactly 17 / 17 / 16", async () => {
    const { deps } = setup();
    const day = "2026-10-27";
    for (let i = 0; i < 60; i++) {
      const m = nextAssignee(countsByMember(await deps.selections!.forDay(day)));
      if (!m) break;
      await deps.selections!.put({ companyKey: `k-${i}`, date: day, connectionId: `c${i}`, assignedTo: m, contactName: "x", emailStatus: "public", createdAt: new Date(clock + i).toISOString(), draftedFor: [] });
    }
    const counts = (await deps.selections!.forDay(day)).reduce<Record<string, number>>((a, s) => ((a[s.assignedTo] = (a[s.assignedTo] ?? 0) + 1), a), {});
    expect(counts).toEqual({ anni: 17, lukky: 17, rishii: 16 });
  });

  it("stops selecting once the day's 50 are shared out (extra companies still save contacts, and still get drafts, but no one is assigned)", async () => {
    const { deps, mail } = setup();
    const day = "2026-10-27";
    const seeded = [...Array(17).fill("anni"), ...Array(17).fill("lukky"), ...Array(16).fill("rishii")] as ("anni" | "lukky" | "rishii")[];
    for (const [i, m] of seeded.entries()) await deps.selections!.put({ companyKey: `seed-${i}`, date: day, connectionId: `c${i}`, assignedTo: m, contactName: "x", emailStatus: "public", createdAt: "2026-10-27T00:00:00.000Z", draftedFor: [] });
    const out = await processCompany(deps, q(mockCompany(1)));
    expect(out.selected).toBeUndefined();
    expect(mail.drafts).toHaveLength(9);
    expect(out.contactsSaved).toHaveLength(3);
    expect(conns().some((r) => r[8].includes("Assigned to"))).toBe(false);
  });
});

describe("Gmail drafts per member", () => {
  it("a member without Gmail connected is skipped without blocking the others, and gets the draft once they connect", async () => {
    const { deps, mail } = setup();
    mail.connected.delete("rishii");
    const out = await processCompany(deps, q(mockCompany(1)));
    expect(out.drafts?.map((d) => d.result)).toEqual(Array(3).fill(["created", "created", "not_authorized"]).flat());
    expect(mail.of("rishii")).toHaveLength(0);
    // While Rishii is not connected, later runs leave Rishii alone (no retries, no ledger writes every run).
    const rows = mail.rows.length;
    expect(await runPendingDrafts(deps)).toEqual({ checked: 0, created: 0, remaining: 0 });
    expect(mail.rows).toHaveLength(rows);
    mail.connected.add("rishii");
    expect(await runPendingDrafts(deps)).toEqual({ checked: 3, created: 3, remaining: 0 }); // the selected contact first
    expect(mail.of("rishii")).toHaveLength(3);
    expect(mail.of("rishii")[0].to).toBe("riya.talent@mock1.example.test");
    expect(mail.drafts).toHaveLength(9);
    expect(await runPendingDrafts(deps)).toEqual({ checked: 0, created: 0, remaining: 0 }); // nothing left: no duplicates
    expect((await deps.selections!.all())[0].draftedFor.sort()).toEqual(["anni", "lukky", "rishii"]);
  });

  it("the pending-draft catch-up stops when the run's time is up and finishes on the next run", async () => {
    const { deps, mail } = setup();
    mail.connected.delete("lukky");
    await processCompany(deps, q(mockCompany(1)));
    mail.connected.add("lukky");
    deps.runState = { deadline: Date.now() + 5_000 }; // less than one draft round left
    expect(await runPendingDrafts(deps)).toEqual({ checked: 0, created: 0, remaining: 3 });
    deps.runState = {};
    expect(await runPendingDrafts(deps, { limit: 2 })).toEqual({ checked: 2, created: 2, remaining: 1 });
    expect(await runPendingDrafts(deps)).toEqual({ checked: 1, created: 1, remaining: 0 });
    expect(mail.of("lukky")).toHaveLength(3);
  });

  it("a company started with little time left saves its contacts and leaves the drafts for the next run", async () => {
    const { deps, mail } = setup();
    deps.runState = { deadline: Date.now() + 10_000 };
    const out = await processCompany(deps, q(mockCompany(1)));
    expect(out.contactsSaved).toHaveLength(3);
    expect(out.draftsDeferred).toBe(3);
    expect(mail.drafts).toHaveLength(0);
    deps.runState = {};
    expect(await runPendingDrafts(deps)).toMatchObject({ checked: 3, created: 9 });
  });

  it("a sent draft later moves the Connection Not Connected → Messaged; per member; deleted or unknown changes nothing", async () => {
    const { deps, mail } = setup();
    const out = await processCompany(deps, q(mockCompany(1)));
    const connectionId = out.selected!.connectionId;
    const fate: Record<string, "draft_exists" | "sent" | "deleted" | "unknown"> = { anni: "draft_exists", lukky: "unknown", rishii: "deleted" };
    // Lukky's draft to the selected contact is the one that gets sent; Lukky's other drafts stay unknown.
    const lukkysDraft = mail.rows.find((r) => r.memberId === "lukky" && r.itemId === connectionId)!.gmailDraftId;
    let lukkySent = false;
    const marks: string[] = [];
    const trackerDeps = {
      pendingDrafts: async () => mail.rows.filter((r) => r.status === "created").map((r) => ({ draftKey: r.draftKey, memberId: r.memberId, connectionId: r.itemId, gmailDraftId: r.gmailDraftId })),
      markDraft: async (d: { draftKey: string }, status: string) => void marks.push(`${d.draftKey}:${status}`),
      checkDraft: async (m: string, draftId: string) => (lukkySent && draftId === lukkysDraft ? "sent" : fate[m]),
      getConnection: async (id: string) => (await existingConnections.list()).find((c) => c.connectionId === id),
      markMessaged: async (c: { memberId: "anni" | "lukky" | "rishii"; connectionId: string }) => {
        const { updateConnection } = await import("@/lib/google-sheets/connections-service");
        await updateConnection(c.memberId, c.connectionId, { status: "Messaged" });
      },
    };
    const first = await runSentTracking(trackerDeps);
    expect(first.markedMessaged).toEqual([]);
    expect(conns().find((r) => r[0] === connectionId)![9]).toBe("Not Connected");
    lukkySent = true;
    const second = await runSentTracking(trackerDeps);
    expect(second.markedMessaged).toEqual([connectionId]);
    expect(conns().find((r) => r[0] === connectionId)![9]).toBe("Messaged");
    // The company's other contacts (drafts not sent) are untouched.
    expect(conns().filter((r) => r[0] !== connectionId).every((r) => r[9] === "Not Connected")).toBe(true);
  });

  it("sent tracking never changes a Connection that is already Connected, Messaged or Reply", async () => {
    const { deps, mail } = setup();
    await processCompany(deps, q(mockCompany(1)));
    const { updateConnection } = await import("@/lib/google-sheets/connections-service");
    const ids = conns().map((r) => r[0]);
    const statuses = ["Connected", "Messaged", "Reply"] as const;
    for (const [i, s] of statuses.entries()) await updateConnection("anni", ids[i], { status: s });
    const before = conns().map((r) => [r[0], r[9], r[11]]);
    let updates = 0;
    const result = await runSentTracking({
      pendingDrafts: async () => mail.rows.filter((r) => r.status === "created").map((r) => ({ draftKey: r.draftKey, memberId: r.memberId, connectionId: r.itemId, gmailDraftId: r.gmailDraftId })),
      markDraft: async () => undefined,
      checkDraft: async () => "sent",
      getConnection: async (id: string) => (await existingConnections.list()).find((c) => c.connectionId === id),
      markMessaged: async () => void updates++,
    });
    expect(result.sent).toHaveLength(9);
    expect(result.markedMessaged).toEqual([]);
    expect(updates).toBe(0);
    expect(conns().map((r) => [r[0], r[9], r[11]])).toEqual(before);
  });
});

describe("Apollo is optional", () => {
  it("a Free-plan refusal (403) is a warning: the batch continues on free sources and Apollo is not asked again this run", async () => {
    const companies = [mockCompany(1), mockCompany(2)];
    const { deps } = setup({ companies });
    const apollo = new MockApollo();
    apollo.failures.set("apollo-test-key-xyz", new ProviderError("apollo", "forbidden", "this endpoint is not included in the account's Apollo plan"));
    deps.contacts = apollo;
    deps.pool = new ApolloPool(loadApolloAccounts({ APOLLO_API_KEY_1: "apollo-test-key-xyz", APOLLO_DAILY_LIMIT: "100", APOLLO_PER_MINUTE_LIMIT: "100" } as unknown as NodeJS.ProcessEnv), new InMemoryApolloUsageStore(), () => clock);
    const tick = await runBatchTick(deps);
    expect(tick.ran && tick.processed.map((o) => o.contactsSaved.length)).toEqual([3, 3]);
    expect(tick.ran && tick.processed[0].warnings).toContain("apollo: forbidden — continuing with free sources");
    expect(apollo.calls).toHaveLength(1);
    expect(JSON.stringify(tick)).not.toContain("apollo-test-key-xyz");
  });
});

describe("rate limits and failures", () => {
  it("a company site answering 429 is retried after Retry-After, without using up an attempt or saving partial duplicates", async () => {
    const { deps } = setup({ routes: { "https://mock1.example.test/team": { status: 429, headers: { "retry-after": "600" } } } });
    const company = q(mockCompany(1));
    const first = await runBatchTick(deps);
    expect(first.ran && first.processed).toEqual([]);
    expect(await deps.queue.get(`company:${company.key}`)).toMatchObject({ status: "pending", attempts: 0, notBefore: clock + 600_000, lastError: "website: rate_limited" });
    expect(conns()).toHaveLength(0);
  });

  it("Nemotron rate-limited while choosing people → the rule order is used; the batch is not stopped", async () => {
    const { deps } = setup();
    const warnings: string[] = [];
    deps.brain = createNemotronBrain({ apiKey: "test-nvidia-key", model: "nvidia/test", baseUrl: "https://nim.example.test/v1" }, async () => new Response("slow down", { status: 429 }), (m) => warnings.push(m));
    const out = await processCompany(deps, q(mockCompany(1)));
    expect(out.contactsSaved).toEqual(["Riya Talent", "Alex Manager", "Sam Founder"]);
    expect(warnings.some((w) => /people choice failed \(rate_limited\); using rules/.test(w))).toBe(true);
    // With Nemotron down, each draft is written from the role template using only the member's verified facts
    // (never invented, never truncated) instead of failing.
    expect(out.drafts?.every((d) => d.result === "created")).toBe(true);
    expect(JSON.stringify(warnings)).not.toContain("test-nvidia-key");
  });

  it("Gmail failing for one member records a failure for that member only; a later run completes it", async () => {
    const { deps, mail } = setup();
    mail.failFor.add("lukky");
    const out = await processCompany(deps, q(mockCompany(1)));
    expect(out.drafts?.map((d) => d.result)).toEqual(Array(3).fill(["created", "failed", "created"]).flat());
    // Still failing on the next run: recorded again, nothing duplicated for the others.
    expect(await runPendingDrafts(deps)).toEqual({ checked: 3, created: 0, remaining: 0 });
    expect(mail.drafts).toHaveLength(6);
    mail.failFor.clear();
    expect(await runPendingDrafts(deps)).toEqual({ checked: 3, created: 3, remaining: 0 });
    expect(mail.of("lukky")).toHaveLength(3);
    expect(mail.drafts).toHaveLength(9);
  });
});

describe("one summary notification per batch of 10", () => {
  it("sends exactly one team summary when the window's 10 companies are done (none per contact)", async () => {
    const companies = [...Array.from({ length: 7 }, (_, i) => mockCompany(i + 1)), ...Array.from({ length: 3 }, (_, i) => mockCompany(i + 101, { countryCode: ["GB", "SG", "DE"][i] }))];
    const { deps, notifier } = setup({ companies, config: { maxCompaniesPerTick: 4 } });
    for (let i = 0; i < 4; i++) await runBatchTick(deps);
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toMatchObject({ title: "Network Finder batch 3/5: 10 companies", body: "30 new contacts, 10 selected for outreach, 90 Gmail drafts created, 0 jobs added. Nothing was sent.", tag: "nf-batch-2026-10-27#2" });
    expect(await runBatchTick(deps)).toEqual({ ran: false, reason: "batch_complete" });
    expect(notifier.sent).toHaveLength(1);
  });

  it("a partial batch (sources ran dry) is summarised once, marked partial", async () => {
    const { deps, notifier } = setup({ companies: [mockCompany(1), mockCompany(2)] });
    await runBatchTick(deps); // processes both
    await runBatchTick(deps); // nothing new to find → summary
    await runBatchTick(deps);
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0].title).toBe("Network Finder batch 3/5: 2 companies (partial)");
  });
});

describe("1,000-contact limit", () => {
  it("at the limit: no new contacts, all three told once a day, nothing exported or deleted, job search still works", async () => {
    const { deps, notifier, jobSource } = setup({ config: { contactLimit: 3 } });
    for (const n of ["A One", "B Two", "C Three"]) await createConnection("anni", { name: n, status: "Not Connected" });
    const before = conns().map((r) => r.join("|"));
    expect(await runBatchTick(deps)).toEqual({ ran: false, reason: "contact_limit", contacts: 3, limit: 3 });
    await runBatchTick(deps);
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0].title).toBe("Network Finder paused: 3 connections");
    expect(notifier.sent[0].body).toContain("Nothing was exported or deleted");
    expect(conns().map((r) => r.join("|"))).toEqual(before);
    jobSource.searchResults = [mockJob("Intern Co", 1, { title: "Software Engineering Intern" })];
    expect((await runDailyJobSearch(deps)).internships).toEqual(["Software Engineering Intern"]);
  });
});

describe("job discovery from public boards", () => {
  it("reads a company's Greenhouse board found on its own site, keeps relevant fresher roles, saves them as Anni once", async () => {
    const company = mockCompany(1);
    const { deps, fetcher, web } = setup({
      companies: [company],
      routes: {
        "https://mock1.example.test/": '<a href="/team">Team</a><a href="https://boards.greenhouse.io/mock1">Careers</a>',
        "https://boards-api.greenhouse.io/robots.txt": "User-agent: *\nDisallow: /embed/",
        "https://boards-api.greenhouse.io/v1/boards/mock1/jobs": { type: "application/json", body: JSON.stringify({ jobs: [
          { id: 1, title: "Software Engineer, New Grad", absolute_url: "https://boards.greenhouse.io/mock1/jobs/1", location: { name: "Remote - US" } },
          { id: 2, title: "Senior Staff Engineer", absolute_url: "https://boards.greenhouse.io/mock1/jobs/2", location: { name: "NYC" } },
          { id: 3, title: "Account Executive", absolute_url: "https://boards.greenhouse.io/mock1/jobs/3", location: { name: "NYC" } },
        ] }) },
      },
    });
    deps.jobSources = [createCompanyBoardSource(fetcher)];
    const out = await processCompany(deps, q(company));
    // The homepage was read once and shared by the contact and job steps (per-run page cache).
    expect(web.requests.filter((r) => r.url === "https://mock1.example.test/")).toHaveLength(1);
    expect(out.jobsSkipped.map((s) => s.name)).toEqual(["Senior Staff Engineer", "Account Executive"]);
    expect(out.jobsSaved).toEqual(["Software Engineer, New Grad"]);
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0].slice(1, 5)).toEqual(["Mock Startup 1", "Software Engineer, New Grad", "Full-time", "Remote"]);
    expect(jobs()[0][10]).toContain("via Greenhouse");
    expect(jobs()[0][11]).toBe("anni");
    await processCompany(deps, q(company));
    expect(jobs()).toHaveLength(1);
  });

  it("daily search: 5 internships + 5 full-time from Remote OK / Arbeitnow, remote first, one per company, credited to the source", async () => {
    const { deps } = setup();
    const remoteok = [{ legal: "API terms" }, ...Array.from({ length: 6 }, (_, i) => ({ id: i, company: `ROK Co ${i}`, position: i < 3 ? "Software Engineering Intern" : "Junior Backend Engineer", url: `https://remoteOK.com/remote-jobs/${i}`, tags: [], location: "" }))];
    const arbeitnow = { data: [
      ...Array.from({ length: 4 }, (_, i) => ({ slug: `a${i}`, company_name: `AN Co ${i}`, title: "Data Analyst Intern", url: `https://www.arbeitnow.com/jobs/a${i}`, remote: false, job_types: ["internship"], location: "Berlin" })),
      ...Array.from({ length: 4 }, (_, i) => ({ slug: `b${i}`, company_name: `AN FT ${i}`, title: "Frontend Developer", url: `https://www.arbeitnow.com/jobs/b${i}`, remote: i === 0, job_types: ["full-time"], location: "Munich" })),
    ] };
    const f = testFetcher(mockWeb({
      "https://remoteok.com/api": { type: "application/json", body: JSON.stringify(remoteok) },
      "https://www.arbeitnow.com/api/job-board-api": { type: "application/json", body: JSON.stringify(arbeitnow) },
    }).fetchFn, () => clock);
    deps.jobSources = [createRemoteOkSource(f), createArbeitnowSource(f)];
    const day = await runDailyJobSearch(deps);
    expect(day.internships).toHaveLength(5);
    expect(day.fullTime).toHaveLength(5);
    // Remote first: the three Remote OK internships come before the on-site Berlin ones.
    expect(jobs().filter((j) => j[3] === "Internship").slice(0, 3).every((j) => j[4] === "Remote")).toBe(true);
    expect(new Set(jobs().map((j) => j[1])).size).toBe(10);
    expect(jobs().every((j) => j[11] === "anni")).toBe(true);
    expect(jobs().filter((j) => j[10].includes("via Remote OK")).length).toBeGreaterThan(0);
    expect(await runDailyJobSearch(deps)).toMatchObject({ internships: [], fullTime: [] });
  });
});

describe("restart / resume on the durable Network Finder sheets", () => {
  function sheetDeps(base: PipelineDeps) {
    const stores = createSheetsStores();
    return { ...base, queue: stores.queue, registry: stores.registry, ledger: stores.ledger, selections: stores.selections, runState: {} } as PipelineDeps;
  }

  it("a crash mid-company (spreadsheet error) leaves the company queued; a NEW run resumes it with no duplicates", async () => {
    const { deps: base, mail } = setup();
    const company = q(mockCompany(1));
    const first = sheetDeps(base);
    await first.queue.enqueue(`company:${company.key}`, { company }, clock);
    await first.registry.put({ key: company.key, name: company.name, source: "hn", sourceId: "1", country: "US", sizeTier: 25, reasons: [], status: "queued", firstSeenAt: new Date(clock).toISOString(), contactsSaved: 0, jobsSaved: 0 });
    await first.ledger.add("2026-10-27#enqueued", 1);
    // Fail the SECOND Connections append: one contact saved, then the run "crashes".
    let appends = 0;
    const realAppend = sheets.appendValues.bind(sheets);
    sheets.appendValues = async (range: string, rows: string[][]) => {
      if (range.startsWith("Connections") && ++appends === 2) throw googleError(500);
      return realAppend(range, rows);
    };
    const crashed = await runBatchTick(first);
    expect(crashed.ran && crashed.processed).toEqual([]);
    expect(conns()).toHaveLength(1);
    expect(sheets.dataRows("NF_Queue")[0].slice(0, 3)).toEqual([`company:${company.key}`, "pending", "1"]);
    sheets.appendValues = realAppend;

    clock += 2 * 60_000; // past the backoff
    const second = sheetDeps(base); // a brand-new invocation: everything re-read from the sheets
    const resumed = await runBatchTick(second);
    expect(resumed.ran && resumed.processed).toHaveLength(1);
    expect(conns()).toHaveLength(3);
    expect(new Set(conns().map((r) => r[2])).size).toBe(3);
    expect(sheets.dataRows("NF_Queue")[0][1]).toBe("done");
    expect(sheets.dataRows("NF_Selections")).toHaveLength(1);
    expect(mail.drafts).toHaveLength(9); // 3 contacts × 3 mailboxes, none twice
    expect(sheets.dataRows("NF_State").find((r) => r[0] === "ledger:2026-10-27#2")?.[1]).toBe("1");
  });

  it("a run that dies holding a company (lease) gives it back after the lease expires", async () => {
    const { deps: base } = setup();
    const company = q(mockCompany(1));
    const a = sheetDeps(base);
    await a.queue.enqueue(`company:${company.key}`, { company }, clock);
    const claimed = await a.queue.claim(clock);
    expect(claimed?.status).toBe("running");
    const b = sheetDeps(base);
    expect(await b.queue.claim(clock + 1000)).toBeNull(); // still leased
    expect((await b.queue.claim(clock + LEASE_MS + 1))?.id).toBe(`company:${company.key}`);
  });

  it("the run lock lets only one scheduled run work at a time, and expires by itself", async () => {
    const s1 = createSheetsStores();
    expect(await s1.acquireRunLock(clock, 300_000)).toBe(true);
    const s2 = createSheetsStores();
    expect(await s2.acquireRunLock(clock + 1000, 300_000)).toBe(false);
    expect(await createSheetsStores().acquireRunLock(clock + 300_001, 300_000)).toBe(true);
  });
});
