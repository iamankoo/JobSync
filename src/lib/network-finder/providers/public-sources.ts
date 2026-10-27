import { ProviderError } from "../errors";
import { countryFromLocation, isRemote } from "../geo";
import { bareHost, extractLinks, htmlToText } from "../http/html";
import type { PoliteFetcher } from "../http/polite-fetch";
import type { CompanyCandidate } from "../types";
import type { CompanySource, DiscoverPage, DiscoverQuery } from "./types";

/**
 * FREE company discovery from permitted public sources (no scraping of YC, Wellfound or LinkedIn):
 *
 *  - "hn": the monthly "Ask HN: Who is hiring?" thread through the public HN Search API (hn.algolia.com/api,
 *    no robots restrictions, no login). Each top-level post is a company describing itself and its openings.
 *  - "remoteintech": the open-source remoteintech.company directory (ISC licence) read from its public GitHub
 *    repository: website, careers page, remote policy and a stated size band per company.
 *
 * Only what the post / profile literally states is used. Size and country are left unknown when not stated
 * (the qualifier then rejects or an optional enrichment fills them in from a real source).
 */

/** Hosts that are job boards / link hubs, not the company's own website. */
export const ATS_HOSTS = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|breezy\.hr|recruitee\.com|bamboohr\.com|smartrecruiters\.com|jobvite\.com|teamtailor\.com|personio\.(de|com)|workatastartup\.com|ycombinator\.com|wellfound\.com|angel\.co|linkedin\.com|notion\.site|notion\.so|docs\.google\.com|forms\.gle|google\.com|github\.com|twitter\.com|x\.com|calendly\.com|typeform\.com|tally\.so|airtable\.com|rippling\.com|gem\.com|dover\.(io|com)|join\.com|welcometothejungle\.com|wttj\.co|hnhiring\.com)$/i;
const CAREERS_HOSTS = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|breezy\.hr|recruitee\.com|bamboohr\.com|smartrecruiters\.com|jobvite\.com|teamtailor\.com|personio\.(de|com)|rippling\.com|dover\.(io|com)|join\.com)$/i;

/** "about 12 people", "team of 8", "a 15-person team", "40 employees" — only explicit statements. */
export function statedEmployeeCount(text: string): number | undefined {
  const patterns = [
    /\bteam of (\d{1,4})\b/i,
    /\b(\d{1,4})[\s-]?(?:person|people|member)\s+(?:team|company|startup)\b/i,
    // Only when it is about the company itself ("we are 30 people"), not its users ("used by 500 people").
    /\b(?:we(?:'re| are| have)|team(?: is)?|company of|currently|now)\s+(?:a\s+)?(?:about|around|~|over|under|just|only)?\s*(\d{1,4})\+?\s+(?:employees|people|staff|ftes?)\b/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    const n = m ? Number(m[1]) : NaN;
    if (Number.isInteger(n) && n >= 1 && n <= 100_000) return n;
  }
  return undefined;
}

interface AlgoliaHit {
  objectID: string;
  title?: string;
  created_at_i?: number;
}
interface AlgoliaItem {
  id: number;
  text?: string | null;
  author?: string | null;
  children?: AlgoliaItem[];
}

/** One "Who is hiring?" post → a company candidate (null when the post does not name a company clearly). */
export function parseHiringPost(post: { id: number | string; html: string }): CompanyCandidate | null {
  const url = `https://news.ycombinator.com/item?id=${post.id}`;
  const text = htmlToText(post.html);
  const firstLine = text.split("\n")[0] ?? "";
  if (!firstLine.includes("|")) return null; // the thread's convention: "Company | Role | Location | …"
  const segments = firstLine.split("|").map((s) => s.trim()).filter(Boolean);
  const rawName = segments[0] ?? "";
  const tags: string[] = [];
  const name = rawName
    .replace(/\((?:YC|Y Combinator)[^)]*\)/gi, (m) => (tags.push(m.replace(/[()]/g, "").trim()), " "))
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s\-–—:,(]+$/, "")
    .trim();
  // A company name is short; a sentence before the first "|" is a comment, not a company.
  if (!name || name.length > 60 || name.split(/\s+/).length > 5 || /^(hiring|we are hiring|remote)$/i.test(name)) return null;

  const links = extractLinks(post.html, "https://news.ycombinator.com/").filter((l) => /^https?:/i.test(l.href));
  // The company's own site: a domain written in the name segment, else the first non-board link.
  const domainInName = /\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|io|ai|co|dev|app|so|tech|org|net|xyz|inc|us|uk|de|fr|sg|ca|au|it|pl|ae))\b/i.exec(rawName)?.[1];
  const own = links.find((l) => {
    const h = bareHost(l.href);
    return h && h !== "news.ycombinator.com" && !ATS_HOSTS.test(h);
  });
  const website = domainInName ? `https://${domainInName.toLowerCase()}` : own ? new URL(own.href).origin : undefined;
  const careers = links.find((l) => {
    const h = bareHost(l.href);
    return h && (CAREERS_HOSTS.test(h) || /\/(careers|jobs)\b/i.test(new URL(l.href).pathname));
  });
  const locationSegments = segments.slice(1).filter((s) => countryFromLocation(s) || isRemote(s) || /onsite|on-site|hybrid/i.test(s));
  const location = locationSegments.join(" | ");
  const country = countryFromLocation(location) ?? countryFromLocation(firstLine.replace(rawName, ""));
  const employees = statedEmployeeCount(text);
  return {
    source: "hn",
    sourceId: String(post.id),
    sourceUrl: url,
    name,
    ...(website ? { website } : {}),
    ...(employees ? { employeeCount: employees } : {}),
    ...(country && country !== "OTHER" ? { countryCode: country } : country === "OTHER" ? { countryCode: "ZZ" } : {}),
    ...(location ? { city: location.slice(0, 120) } : {}),
    remoteFriendly: isRemote(firstLine),
    hiring: true,
    description: text.slice(0, 600),
    ...(tags.length ? { tags } : {}),
    ...(careers ? { careersUrl: careers.href } : {}),
    sourceText: text.slice(0, 4000),
  };
}

export function createHnHiringSource(fetcher: PoliteFetcher, api = "https://hn.algolia.com/api/v1"): CompanySource {
  return {
    id: "hn",
    async discover(query: DiscoverQuery): Promise<DiscoverPage> {
      // Cursor "storyId:offset" keeps our place in the current month's thread across runs.
      const [storyFromCursor, offsetRaw] = (query.cursor ?? "").split(":");
      const hits = await fetcher.getJson<{ hits?: AlgoliaHit[] }>(`${api}/search_by_date?tags=story,author_whoishiring&hitsPerPage=5`, "hn");
      const latest = (hits?.hits ?? []).find((h) => /^Ask HN: Who is hiring\?/i.test(h.title ?? ""));
      if (!latest) throw new ProviderError("hn", "invalid_response", "no current 'Who is hiring?' thread found");
      const offset = storyFromCursor === latest.objectID ? Number(offsetRaw) || 0 : 0;
      const item = await fetcher.getJson<AlgoliaItem>(`${api}/items/${encodeURIComponent(latest.objectID)}`, "hn");
      if (!item || !Array.isArray(item.children)) throw new ProviderError("hn", "invalid_response", "thread has no posts");
      const posts = item.children.filter((c) => c.text && c.author);
      const companies: CompanyCandidate[] = [];
      let i = offset;
      for (; i < posts.length && companies.length < query.limit; i++) {
        const c = parseHiringPost({ id: posts[i].id, html: posts[i].text! });
        if (c) companies.push(c);
      }
      return { companies, ...(i < posts.length ? { nextCursor: `${latest.objectID}:${i}` } : {}) };
    },
  };
}

// ---- remoteintech -----------------------------------------------------------------------------------------

/** Upper bound of the directory's size bands (the band is kept as stated). */
const SIZE_BANDS: Record<string, { max: number; label: string }> = {
  tiny: { max: 10, label: "1-10" },
  small: { max: 50, label: "11-50" },
  medium: { max: 200, label: "51-200" },
  large: { max: 1000, label: "201-1000" },
  enterprise: { max: 100_000, label: "1000+" },
};

/** One company profile (front matter + "## Company size" section) → candidate. */
export function parseRemoteInTechProfile(slug: string, md: string): CompanyCandidate | null {
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(md)?.[1];
  if (!fm) return null;
  const field = (k: string) => new RegExp(`^${k}:\\s*["']?(.*?)["']?\\s*$`, "m").exec(fm)?.[1]?.trim();
  const name = field("title");
  if (!name) return null;
  const website = field("website");
  const band = SIZE_BANDS[(field("company_size") ?? "").toLowerCase()];
  const sizeSection = /##\s*Company size\s*\n+([\s\S]*?)(\n##|$)/i.exec(md)?.[1]?.trim() ?? "";
  // A number stated in the profile's own "Company size" section wins over the band.
  const stated = /^\D{0,20}?(\d{1,5})\b/.exec(sizeSection)?.[1];
  const employeeCount = stated && Number(stated) > 0 ? Number(stated) : band?.max;
  const blurb = /##\s*Company blurb\s*\n+([\s\S]*?)(\n##|$)/i.exec(md)?.[1]?.replace(/\s+/g, " ").trim();
  const remotePolicy = field("remote_policy");
  const techs = [...fm.matchAll(/^\s+-\s+(\S+)/gm)].map((m) => m[1]);
  return {
    source: "remoteintech",
    sourceId: slug,
    sourceUrl: `https://remoteintech.company/${slug}/`,
    name,
    ...(website ? { website } : {}),
    ...(employeeCount ? { employeeCount } : {}),
    ...(!stated && band ? { employeeRange: band.label } : {}),
    remoteFriendly: Boolean(remotePolicy),
    ...(field("careers_url") ? { careersUrl: field("careers_url") } : {}),
    ...(blurb ? { description: blurb.slice(0, 600) } : {}),
    tags: [...(remotePolicy ? [remotePolicy] : []), ...(field("region") ? [`region:${field("region")}`] : []), ...techs].slice(0, 20),
  };
}

export function createRemoteInTechSource(fetcher: PoliteFetcher, repo = "remoteintech/remote-jobs"): CompanySource {
  let slugs: string[] | null = null;
  return {
    id: "remoteintech",
    async discover(query: DiscoverQuery): Promise<DiscoverPage> {
      if (!slugs) {
        const tree = await fetcher.getJson<{ tree?: { path: string }[] }>(`https://api.github.com/repos/${repo}/git/trees/main?recursive=1`, "remoteintech");
        slugs = (tree?.tree ?? []).map((t) => /^src\/companies\/([a-z0-9-]+)\.md$/.exec(t.path)?.[1]).filter((s): s is string => Boolean(s)).sort();
        if (!slugs.length) throw new ProviderError("remoteintech", "invalid_response", "no company profiles found");
      }
      const start = Number(query.cursor ?? 0) || 0;
      const companies: CompanyCandidate[] = [];
      let i = start;
      for (; i < slugs.length && companies.length < query.limit; i++) {
        const r = await fetcher.get(`https://raw.githubusercontent.com/${repo}/main/src/companies/${slugs[i]}.md`, "remoteintech", { accept: "text/plain" });
        if (r.status !== 200) continue;
        const c = parseRemoteInTechProfile(slugs[i], r.text);
        // Bands above our 250 cap are never fetched further.
        if (c && (c.employeeCount === undefined || c.employeeCount <= query.maxEmployees)) companies.push(c);
      }
      return { companies, ...(i < slugs.length ? { nextCursor: String(i) } : {}) };
    },
  };
}
