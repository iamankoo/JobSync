import { ProviderError } from "../errors";
import { countryFromLocation } from "../geo";
import { extractLinks, htmlToText, normalizeSpace } from "../http/html";
import type { PoliteFetcher } from "../http/polite-fetch";
import type { CompanyCandidate } from "../types";
import { statedEmployeeCount } from "./public-sources";
import type { ExtractPage } from "./types";

/**
 * FREE qualification facts from the company's OWN public pages (homepage, /about, /company), for candidates whose
 * discovery source did not state a size or country:
 *
 *  1. rules: an explicit size sentence ("a team of 12", "we are 30 people") found by the same patterns as the posts;
 *  2. Nemotron (optional): reads the pages and returns the SENTENCE that states the size / headquarters. The
 *     sentence must appear on the page, the number must be in it, and the country is read from it by the same
 *     place rules as everywhere else. An answer that does not check out is ignored — nothing is guessed.
 *
 * A team page listing faces is not a size statement and is never counted.
 */
export interface CompanyFactsAnswer {
  sizeQuote?: string;
  employees?: number;
  hqQuote?: string;
}

export interface CompanyFactsExtractor {
  readonly id: string;
  extractFacts(input: { companyName: string; pages: ExtractPage[] }): Promise<CompanyFactsAnswer>;
}

export interface CompanyFacts {
  employeeCount?: number;
  countryCode?: string;
  /** Human-readable provenance kept with the company (e.g. "size stated on https://x.io/about"). */
  source: string;
}

const PAGE_CHARS = 6000;
const SIZE_WORDS = /\b(employees?|people|staff|team|members?|persons?|ftes?|engineers?)\b/i;

/** The page whose text contains `quote` (whitespace / case-insensitive), or undefined. */
function pageWith(quote: string | undefined, pages: readonly ExtractPage[]): ExtractPage | undefined {
  const q = normalizeSpace(quote ?? "");
  if (q.length < 6) return undefined;
  return pages.find((p) => normalizeSpace(p.text).includes(q));
}

/** Checks a model answer against the pages; returns only what the pages literally support. */
export function verifyFacts(answer: CompanyFactsAnswer, pages: readonly ExtractPage[]): CompanyFacts | null {
  const parts: string[] = [];
  const out: Omit<CompanyFacts, "source"> = {};
  const sizePage = pageWith(answer.sizeQuote, pages);
  if (sizePage && answer.sizeQuote && SIZE_WORDS.test(answer.sizeQuote)) {
    // Years ("founded in 2019") are not head counts.
    const numbers = (answer.sizeQuote.match(/\b\d{1,4}\b/g) ?? []).map(Number).filter((n) => n >= 1 && !(n >= 1900 && n <= 2100));
    // A stated range ("10-20 people") counts as its upper bound; the model's number must be one stated in the sentence.
    const stated = statedEmployeeCount(answer.sizeQuote) ?? (numbers.length ? Math.max(...numbers) : undefined);
    if (stated !== undefined && (answer.employees === undefined || numbers.includes(answer.employees))) {
      out.employeeCount = stated;
      parts.push(`size stated on ${sizePage.url}`);
    }
  }
  const hqPage = pageWith(answer.hqQuote, pages);
  const country = hqPage ? countryFromLocation(answer.hqQuote) : undefined;
  if (hqPage && country && country !== "OTHER") {
    out.countryCode = country;
    parts.push(`location stated on ${hqPage.url}`);
  }
  return parts.length ? { ...out, source: parts.join("; ") } : null;
}

export function createCompanyFactsFinder(fetcher: PoliteFetcher, extractor: CompanyFactsExtractor | null) {
  return {
    id: "company-website",
    /** Size and/or country the company states about itself; null when its pages do not say. */
    async find(c: CompanyCandidate): Promise<CompanyFacts | null> {
      if (!c.website) return null;
      const pages: ExtractPage[] = [];
      const read = async (url: string) => {
        try {
          const r = await fetcher.get(url, "website");
          if (r.status !== 200 || !/html/i.test(r.contentType) || pages.some((p) => p.url === r.url)) return;
          pages.push({ url: r.url, text: htmlToText(r.text), links: extractLinks(r.text, r.url) });
        } catch (err) {
          if (err instanceof ProviderError && err.kind === "rate_limited") throw err;
        }
      };
      await read(c.website);
      if (pages.length === 0) return null;
      const about = pages[0].links.find((l) => /\/(about|about-us|company|who-we-are)\/?$/i.test(new URL(l.href).pathname) && new URL(l.href).host === new URL(pages[0].url).host);
      await read(about?.href ?? new URL("/about", pages[0].url).toString());

      // Rules first: an explicit size sentence needs no model.
      const needSize = c.employeeCount === undefined;
      const needCountry = !c.countryCode;
      const result: CompanyFacts = { source: "" };
      const sources: string[] = [];
      if (needSize) {
        for (const p of pages) {
          const n = statedEmployeeCount(p.text);
          if (n !== undefined) {
            result.employeeCount = n;
            sources.push(`size stated on ${p.url}`);
            break;
          }
        }
      }
      if ((needSize && result.employeeCount === undefined) || needCountry) {
        if (extractor) {
          const answer = await extractor.extractFacts({ companyName: c.name, pages: pages.map((p) => ({ url: p.url, text: p.text.slice(0, PAGE_CHARS), links: [] })) });
          const v = verifyFacts(answer, pages);
          if (v?.employeeCount !== undefined && needSize && result.employeeCount === undefined) {
            result.employeeCount = v.employeeCount;
            sources.push(v.source.split("; ").find((s) => s.startsWith("size")) ?? v.source);
          }
          if (v?.countryCode && needCountry) {
            result.countryCode = v.countryCode;
            sources.push(v.source.split("; ").find((s) => s.startsWith("location")) ?? v.source);
          }
        }
      }
      if (!sources.length) return null;
      return { ...result, source: sources.join("; ") };
    },
  };
}
