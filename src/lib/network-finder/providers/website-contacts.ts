import { classifyPersona } from "../contacts";
import { domainOf } from "../dedupe";
import { ProviderError } from "../errors";
import { bareHost, extractEmails, extractLinks, htmlToText, normalizeSpace, sameSite, type PageLink } from "../http/html";
import type { PoliteFetcher } from "../http/polite-fetch";
import type { EnrichedPerson, QualifiedCompany } from "../types";
import type { ContactFinder, ContactFinding, ExtractPage, ExtractedPerson, PeopleExtractor } from "./types";

/**
 * FREE contact discovery from the company's own public pages (homepage → team / about / leadership / contact /
 * careers pages on the same site, robots.txt respected) plus the public post the company was found in.
 *
 * An extractor (Nemotron) reads names and titles off the text; EVERY field it returns is then checked against
 * the pages: the name and title must appear in that page's text, an email must be published on the pages, a
 * phone number's digits must appear on the page, a LinkedIn URL must be a link on the pages. Anything that does
 * not check out is dropped — nothing is invented.
 */
const SUBPAGE_HINT = /\b(team|our[\s-]team|people|leadership|founders?|about|about[\s-]us|company|who[\s-]we[\s-]are|our[\s-]story|contact|careers|jobs)\b/i;
const SUBPAGE_PRIORITY = [/team|people/i, /leadership|founder/i, /about|who-we-are|story/i, /company/i, /contact/i, /careers|jobs/i];
const MAX_SUBPAGES = 3;
const PAGE_CHARS = 6000;

function pickSubpages(links: readonly PageLink[], site: string, already: Set<string>): string[] {
  const scored: { url: string; rank: number }[] = [];
  for (const l of links) {
    const h = bareHost(l.href);
    if (!h || !sameSite(h, site) || !/^https?:/i.test(l.href)) continue;
    const u = new URL(l.href);
    u.hash = "";
    const url = u.toString();
    if (already.has(url) || /\.(pdf|png|jpe?g|zip|svg)$/i.test(u.pathname) || u.pathname === "/") continue;
    const hay = `${u.pathname} ${l.text}`;
    if (!SUBPAGE_HINT.test(hay)) continue;
    const rank = SUBPAGE_PRIORITY.findIndex((re) => re.test(hay));
    scored.push({ url, rank: rank < 0 ? SUBPAGE_PRIORITY.length : rank });
    already.add(url);
  }
  return scored.sort((a, b) => a.rank - b.rank).slice(0, MAX_SUBPAGES).map((s) => s.url);
}

const digits = (s: string) => s.replace(/\D/g, "");

/** 2–4 name-like words, no digits, slashes or company words ("Open Education / Neon" is not a person). */
export function looksLikePersonName(name: string, companyName = ""): boolean {
  const words = name.trim().split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  if (/[\d/|@&:()]/.test(name)) return false;
  if (!words.every((w) => /^[\p{Lu}][\p{L}'’.-]*$/u.test(w))) return false;
  if (/\b(inc|llc|ltd|labs?|technologies|solutions|team|careers|foundation|group|company|studio|ai)\b/i.test(name)) return false;
  return !companyName || normalizeSpace(name) !== normalizeSpace(companyName);
}

/** Keeps only what the pages support; null when the person themself is not on the page. */
export function verifyExtracted(p: ExtractedPerson, pages: readonly ExtractPage[], publishedEmails: ReadonlySet<string>): Omit<EnrichedPerson, "companyName"> | null {
  const page = pages.find((x) => x.url === p.pageUrl) ?? pages.find((x) => normalizeSpace(x.text).includes(normalizeSpace(p.name ?? "")));
  if (!page || typeof p.name !== "string" || typeof p.title !== "string") return null;
  const text = normalizeSpace(page.text);
  const name = p.name.replace(/\s+/g, " ").trim();
  const title = p.title.replace(/\s+/g, " ").trim();
  if (name.length < 3 || name.length > 80 || !/\s/.test(name) || !text.includes(normalizeSpace(name))) return null;
  if (!title || title.length > 120 || !text.includes(normalizeSpace(title))) return null;
  const email = p.email?.trim().toLowerCase();
  const emailOk = email && publishedEmails.has(email);
  const allLinks = pages.flatMap((x) => x.links.map((l) => l.href));
  const linkedin = p.linkedinUrl?.trim();
  const linkedinOk = linkedin && /linkedin\.com\/in\//i.test(linkedin) && allLinks.some((h) => h.replace(/\/+$/, "").toLowerCase() === linkedin.replace(/\/+$/, "").toLowerCase());
  const phone = p.phone?.trim();
  const phoneOk = phone && digits(phone).length >= 7 && digits(page.text).includes(digits(phone));
  return {
    provider: "website",
    name,
    title,
    sourceUrl: page.url,
    ...(emailOk ? { email, emailStatus: "public" as const, emailSource: page.url } : { emailStatus: "unavailable" as const }),
    ...(linkedinOk ? { linkedinUrl: linkedin } : {}),
    ...(phoneOk ? { phone } : {}),
    ...(/^https?:/i.test(page.url) && !/news\.ycombinator\.com/.test(page.url) ? { otherUrl: page.url } : {}),
  };
}

export function createWebsiteContactFinder(fetcher: PoliteFetcher, extractor: PeopleExtractor | null): ContactFinder {
  return {
    id: "website",
    async findPeople(company: QualifiedCompany): Promise<ContactFinding> {
      const pages: ExtractPage[] = [];
      let site = company.domain ?? domainOf(company.website);
      const read = async (url: string) => {
        try {
          const r = await fetcher.get(url, "website");
          if (r.status !== 200 || !/html/i.test(r.contentType)) return null;
          const page = { url: r.url, text: htmlToText(r.text), links: extractLinks(r.text, r.url) };
          pages.push(page);
          return page;
        } catch (err) {
          // A disallowed or failing page is skipped; a rate limit stops the company (retried later).
          if (err instanceof ProviderError && err.kind === "rate_limited") throw err;
          return null;
        }
      };
      const hosts = new Set<string>(site ? [site] : []);
      if (site) {
        const home = await read(company.website ?? `https://${site}`);
        // The site moved (e.g. a rebrand redirect): its new host is the company's site too.
        const finalHost = home ? bareHost(home.url) : null;
        if (finalHost && !sameSite(finalHost, site)) {
          hosts.add(finalHost);
          site = finalHost;
        }
        const seen = new Set<string>([home?.url ?? ""]);
        const subpages = home ? pickSubpages(home.links, site, seen) : [];
        // No team-like page linked: try the two conventional addresses (robots.txt still applies; a 404 costs nothing).
        if (home && !subpages.some((u) => /team|people|leadership|founder/i.test(u))) {
          for (const path of ["/team", "/about"]) {
            const u = new URL(path, home.url).toString();
            if (!seen.has(u) && !subpages.includes(u)) subpages.push(u);
          }
        }
        if (company.careersUrl && sameSite(bareHost(company.careersUrl) ?? "", site) && !seen.has(company.careersUrl)) subpages.push(company.careersUrl);
        for (const url of subpages.slice(0, MAX_SUBPAGES + 1)) await read(url);
      }
      // The public post the company was found in (e.g. its HN hiring post) often names the hiring person.
      if (company.sourceText && company.sourceUrl) pages.push({ url: company.sourceUrl, text: company.sourceText, links: [] });

      const publishedEmails: { email: string; sourceUrl: string }[] = [];
      for (const p of pages) {
        for (const e of extractEmails(p.text, p.links)) {
          const host = e.split("@")[1];
          if (host && [...hosts].some((h) => sameSite(host, h)) && !publishedEmails.some((x) => x.email === e)) publishedEmails.push({ email: e, sourceUrl: p.url });
        }
      }
      if (!extractor || pages.length === 0) return { people: [], publishedEmails, pages: pages.map((p) => p.url), hosts: [...hosts] };

      const extracted = await extractor.extractPeople({ companyName: company.name, pages: pages.map((p) => ({ ...p, text: p.text.slice(0, PAGE_CHARS), links: p.links.filter((l) => /linkedin\.com\/in\/|^mailto:/i.test(l.href)).slice(0, 60) })) });
      const emailSet = new Set(publishedEmails.map((e) => e.email));
      const people: EnrichedPerson[] = [];
      for (const x of extracted) {
        const v = verifyExtracted(x, pages, emailSet);
        if (!v || !classifyPersona(v.title) || !looksLikePersonName(v.name, company.name)) continue;
        if (people.some((p) => normalizeSpace(p.name) === normalizeSpace(v.name))) continue;
        people.push({ ...v, companyName: company.name, ...(site ? { companyDomain: site } : {}) });
      }
      return { people, publishedEmails, pages: pages.map((p) => p.url), hosts: [...hosts] };
    },
  };
}
