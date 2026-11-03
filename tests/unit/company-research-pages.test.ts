/**
 * Company research for a connection: starts from the supplied Company URL, reads the official pages it links to (politely),
 * keeps each page's URL as provenance, is reused while fresh and refreshed when the URL changes or the research is stale.
 * Everything runs against a fake website; no real request is made.
 */
import { describe, expect, it } from "vitest";
import { createCompanyResearcher, discoverPages, RESEARCH_RETRY_MS, RESEARCH_TTL_MS, type ResearchStore } from "@/lib/network-finder/company-research";
import { PoliteFetcher } from "@/lib/network-finder/http/polite-fetch";
import type { JobSource } from "@/lib/network-finder/providers/types";

const page = (title: string, description: string, body = "") => `<html><head><title>${title}</title><meta name="description" content="${description}"></head><body>${body}</body></html>`;
const HOME = page(
  "Acme Robotics",
  "Acme builds warehouse robots and the software that coordinates them.",
  `<nav>
    <a href="/about-us">About us</a> <a href="/products/robots">Our products</a> <a href="/engineering">Engineering</a>
    <a href="/careers">Careers</a> <a href="/blog">Blog</a> <a href="https://other-site.com/careers">Partner careers</a>
    <a href="mailto:hi@acme.test">Mail</a> <a href="/careers?utm=x#top">Careers again</a> <a href="/files/deck.pdf">About deck</a>
  </nav>`,
);
const SITE: Record<string, string> = {
  "https://acme-robotics.com/": HOME,
  "https://acme-robotics.com/about-us": page("About Acme", "Acme was founded to automate warehouses."),
  "https://acme-robotics.com/products/robots": page("Products", "Autonomous mobile robots for picking and sorting."),
  "https://acme-robotics.com/engineering": page("Engineering", "Our engineers write C++ and Python for robot fleets."),
  "https://acme-robotics.com/careers": page("Careers", "We are hiring software and robotics engineers."),
  "https://acme-robotics.com/blog": page("Blog", "News from the Acme team."),
};

function setup(overrides: { site?: Record<string, string>; robots?: string; fail?: boolean } = {}) {
  const site = overrides.site ?? SITE;
  const requested: string[] = [];
  const fetchFn = async (url: string) => {
    requested.push(url);
    if (overrides.fail) throw new Error("network down");
    if (url.endsWith("/robots.txt")) return new Response(overrides.robots ?? "", { status: overrides.robots === undefined ? 404 : 200, headers: { "content-type": "text/plain" } });
    const html = site[url];
    return html ? new Response(html, { status: 200, headers: { "content-type": "text/html" } }) : new Response("nope", { status: 404, headers: { "content-type": "text/html" } });
  };
  const boards = { findCompanyJobs: async () => [] } as unknown as JobSource;
  const mem = new Map<string, string>();
  const store: ResearchStore = { get: async (k) => mem.get(k), set: async (k, v) => void mem.set(k, v) };
  let clock = Date.parse("2026-11-03T10:00:00Z");
  // One fetcher per run (it caches pages and robots.txt for that run only), exactly like the scheduled worker.
  const researcher = () => createCompanyResearcher(new PoliteFetcher(fetchFn, async () => undefined, Date.now, 0), boards, { store, now: () => clock });
  return { requested, researcher, mem, advance: (ms: number) => (clock += ms) };
}

describe("discoverPages", () => {
  it("finds one same-site page per kind from real links and nothing else", () => {
    const found = discoverPages(HOME, "https://acme-robotics.com/");
    expect(found).toEqual([
      { kind: "about", url: "https://acme-robotics.com/about-us" },
      { kind: "products", url: "https://acme-robotics.com/products/robots" },
      { kind: "engineering", url: "https://acme-robotics.com/engineering" },
      { kind: "careers", url: "https://acme-robotics.com/careers" },
      { kind: "blog", url: "https://acme-robotics.com/blog" },
    ]);
  });
  it("never invents pages: a home page without those links yields none", () => {
    expect(discoverPages(page("X", "Y", '<a href="/pricing">Pricing</a>'), "https://x.com/")).toEqual([]);
  });
});

describe("researching a company from its URL", () => {
  it("starts at the supplied URL and records each official page read, with its URL", async () => {
    const t = setup();
    const r = await t.researcher()({ name: "Acme Robotics", website: "https://acme-robotics.com/" });
    expect(t.requested.filter((u) => !u.endsWith("robots.txt"))[0]).toBe("https://acme-robotics.com/");
    expect(r.website).toBe("https://acme-robotics.com/");
    expect(r.status).toBe("verified");
    expect(r.description).toBe("Acme builds warehouse robots and the software that coordinates them.");
    expect(r.pages?.map((p) => [p.kind, p.url])).toEqual([
      ["home", "https://acme-robotics.com/"],
      ["about", "https://acme-robotics.com/about-us"],
      ["products", "https://acme-robotics.com/products/robots"],
      ["engineering", "https://acme-robotics.com/engineering"],
      ["careers", "https://acme-robotics.com/careers"],
      ["blog", "https://acme-robotics.com/blog"],
    ]);
    // Facts are the pages' own descriptions, verbatim (nothing summarised or invented).
    expect(r.facts).toContain("Our engineers write C++ and Python for robot fleets.");
    for (const f of r.facts ?? []) expect(r.pages?.some((p) => p.summary === f)).toBe(true);
    // Off-site links are never followed.
    expect(t.requested.some((u) => u.includes("other-site.com"))).toBe(false);
  });

  it("respects robots.txt: a disallowed page is not fetched and not part of the research", async () => {
    const t = setup({ robots: "User-agent: *\nDisallow: /careers\nDisallow: /blog" });
    const r = await t.researcher()({ name: "Acme Robotics", website: "https://acme-robotics.com/" });
    expect(t.requested).not.toContain("https://acme-robotics.com/careers");
    expect(t.requested).not.toContain("https://acme-robotics.com/blog");
    expect(r.pages?.map((p) => p.kind)).toEqual(["home", "about", "products", "engineering"]);
  });

  it("a page that does not exist is simply left out (no invented content); the rest is still verified", async () => {
    const { ["https://acme-robotics.com/engineering"]: _gone, ...rest } = SITE;
    void _gone;
    const t = setup({ site: rest });
    const r = await t.researcher()({ name: "Acme Robotics", website: "https://acme-robotics.com/" });
    expect(r.pages?.some((p) => p.kind === "engineering")).toBe(false);
    expect(r.pages?.length).toBe(5);
  });

  it("only the home page readable → partial; nothing readable → unavailable, reported honestly with no facts", async () => {
    const homeOnly = setup({ site: { "https://acme-robotics.com/": page("Acme", "Acme builds robots.") } });
    expect((await homeOnly.researcher()({ name: "Acme Robotics", website: "https://acme-robotics.com/" })).status).toBe("partial");
    const down = setup({ fail: true });
    const r = await down.researcher()({ name: "Acme Robotics", website: "https://acme-robotics.com/" });
    expect(r).toMatchObject({ status: "unavailable", website: "https://acme-robotics.com/", jobs: [] });
    expect(r.description).toBeUndefined();
    expect(r.pages).toBeUndefined();
    expect(r.facts).toBeUndefined();
  });

  it("without a Company URL the existing safe path is used: guessed addresses are verified against the page and only the home page is read", async () => {
    const t = setup({ site: { "https://acmerobotics.com/": page("Acme Robotics", "Acme builds warehouse robots."), "https://acmerobotics.com/about": page("About", "x") } });
    const r = await t.researcher()({ name: "Acme Robotics" });
    expect(r.website).toBe("https://acmerobotics.com/");
    expect(r.pages?.map((p) => p.kind)).toEqual(["home"]);
    expect(t.requested.filter((u) => /about|careers/.test(u))).toEqual([]);
  });
});

describe("reuse and refresh", () => {
  const input = { name: "Acme Robotics", website: "https://acme-robotics.com/" };

  it("verified research is stored and reused (no new requests) for later runs, including the other two members' drafts", async () => {
    const t = setup();
    await t.researcher()(input);
    const first = t.requested.length;
    const again = await t.researcher()(input); // a new researcher = a later run
    expect(t.requested.length).toBe(first);
    expect(again).toMatchObject({ reused: true, status: "verified" });
    expect(again.pages?.length).toBe(6);
  });

  it("within one run the three drafts share one research promise", async () => {
    const t = setup();
    const r = t.researcher();
    const [a, b, c] = await Promise.all([r(input), r(input), r(input)]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(t.requested.filter((u) => u === "https://acme-robotics.com/").length).toBe(1);
  });

  it("a changed Company URL refreshes the research", async () => {
    const t = setup({ site: { ...SITE, "https://acme.io/": page("Acme", "Acme, new site.") } });
    await t.researcher()(input);
    const r = await t.researcher()({ name: "Acme Robotics", website: "https://acme.io/" });
    expect(r.reused).toBeUndefined();
    expect(r.website).toBe("https://acme.io/");
    expect(t.requested).toContain("https://acme.io/");
  });

  it("stale research (older than the lifetime) is refreshed; fresh research is not", async () => {
    const t = setup();
    await t.researcher()(input);
    t.advance(RESEARCH_TTL_MS - 60_000);
    expect((await t.researcher()(input)).reused).toBe(true);
    t.advance(120_000);
    const before = t.requested.length;
    expect((await t.researcher()(input)).reused).toBeUndefined();
    expect(t.requested.length).toBeGreaterThan(before);
  });

  it("a failed attempt is not hammered: not retried inside the retry gap, retried after it", async () => {
    const down = setup({ fail: true });
    await down.researcher()(input);
    const n = down.requested.length;
    await down.researcher()(input);
    expect(down.requested.length).toBe(n);
    down.advance(RESEARCH_RETRY_MS + 1000);
    await down.researcher()(input);
    expect(down.requested.length).toBeGreaterThan(n);
  });

  it("a corrupted stored note is ignored and research runs again", async () => {
    const t = setup();
    await t.researcher()(input);
    for (const k of t.mem.keys()) t.mem.set(k, "{not json");
    const r = await t.researcher()(input);
    expect(r.status).toBe("verified");
    expect(r.reused).toBeUndefined();
  });
});
