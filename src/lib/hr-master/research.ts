/**
 * Evidence-based assessment of companies, roles and people. Everything here is a pure function of data that was actually
 * fetched (homepage / careers page of the company's own domain) or listed in the source files. Nothing is inferred from a
 * domain name alone and nothing is invented: when the evidence is missing the answer is "Unverified"/"Unknown".
 */
import { companyKey, localPartMatchesName, normalizeDomain, registrableDomain } from "./normalize.ts";
import type {
  ApprovedRoleCategory,
  CompanyAssessment,
  CompanyResearch,
  MergedContact,
  RoleAssessment,
  RoleCategoryOrUnverified,
  Verification,
} from "./types.ts";

/* ------------------------------------------------------------------ HTML helpers */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', copy: "" };

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function metaContent(html: string, attr: "name" | "property", value: string): string {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const a = new RegExp(`${attr}\\s*=\\s*["']${value}["']`, "i");
    if (!a.test(tag)) continue;
    const m = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i.exec(tag);
    const v = m?.[1] ?? m?.[2];
    if (v) return decodeEntities(v).replace(/\s+/g, " ").trim();
  }
  return "";
}

export interface ParsedPage {
  title: string;
  description: string;
  siteName: string;
  links: { href: string; text: string }[];
  text: string;
}

export function parsePage(html: string): ParsedPage {
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const links: { href: string; text: string }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi)) {
    links.push({ href: decodeEntities(m[1] ?? m[2] ?? "").trim(), text: htmlToText(m[3]).slice(0, 80) });
    if (links.length >= 600) break;
  }
  return {
    title: t ? decodeEntities(t[1]).replace(/\s+/g, " ").trim().slice(0, 200) : "",
    description: (metaContent(html, "name", "description") || metaContent(html, "property", "og:description")).slice(0, 400),
    siteName: metaContent(html, "property", "og:site_name").slice(0, 120),
    links,
    text: htmlToText(html),
  };
}

const PARKED_RE = /(domain (is )?(for sale|available)|buy this domain|this domain (may be|is) for sale|parked (domain|free)|sedo\.com|hugedomains|godaddy\.com\/domains|namecheap parking|account suspended|under construction|coming soon|default web site page|apache2? (ubuntu )?default|welcome to nginx|index of \/)/i;

export function looksParked(p: ParsedPage): boolean {
  // A JS-rendered site has little static text but still has a title/description: that is a real site, not a parked page.
  if (p.text.length < 80 && !p.title && !p.description) return true;
  return PARKED_RE.test(`${p.title} ${p.text.slice(0, 600)}`);
}

const CAREERS_LINK_RE = /(career|jobs?\b|join[- ]?(us|our|the)|work[- ]?(with|at)[- ]?us|we[' ]?re[- ]?hiring|openings|opportunit|recruit|vacanc)/i;
const ATS_HOSTS = /(greenhouse\.io|lever\.co|workable\.com|ashbyhq\.com|smartrecruiters\.com|zohorecruit\.|zoho\.com\/recruit|keka\.com|darwinbox\.|freshteam\.com|bamboohr\.com|recruitee\.com|breezy\.hr|myworkdayjobs\.com|icims\.com|jobvite\.com|teamtailor\.com|naukri\.com\/.+-jobs)/i;

/** Picks the most likely careers link on a page (own site or a well-known ATS host), resolved against `baseUrl`. */
export function findCareersUrl(page: ParsedPage, baseUrl: string): string {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return "";
  }
  const own = registrableDomain(base.hostname);
  let best = "";
  let bestScore = 0;
  for (const l of page.links) {
    if (!l.href || /^(mailto:|tel:|javascript:|#)/i.test(l.href)) continue;
    let u: URL;
    try {
      u = new URL(l.href, base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(u.protocol)) continue;
    const hay = `${u.pathname} ${l.text}`;
    if (!CAREERS_LINK_RE.test(hay) && !ATS_HOSTS.test(u.href)) continue;
    const sameSite = registrableDomain(u.hostname) === own;
    if (!sameSite && !ATS_HOSTS.test(u.href)) continue;
    let score = 1;
    if (/career/i.test(u.pathname)) score += 3;
    if (/career|jobs|join/i.test(l.text)) score += 2;
    if (ATS_HOSTS.test(u.href)) score += 2;
    if (/\.(pdf|jpg|png|zip)$/i.test(u.pathname) || /blog|news|press|article|post\//i.test(u.pathname)) score -= 3;
    if (score > bestScore) {
      bestScore = score;
      best = u.href.split("#")[0];
    }
  }
  return best;
}

/* ------------------------------------------------------------------ robots.txt */

/** Minimal robots.txt check for the "*" group: honours Disallow/Allow with longest-match precedence. */
export function robotsAllows(robotsTxt: string, path: string): boolean {
  const rules: { allow: boolean; path: string }[] = [];
  let applies = false;
  let inGroupHeader = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "user-agent") {
      if (!inGroupHeader) applies = false;
      if (val === "*") applies = true;
      inGroupHeader = true;
    } else {
      inGroupHeader = false;
      if (applies && (key === "disallow" || key === "allow") && val) rules.push({ allow: key === "allow", path: val });
    }
  }
  let verdict = true;
  let longest = -1;
  for (const r of rules) {
    const pattern = r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$");
    if (new RegExp("^" + pattern).test(path) && r.path.length > longest) {
      longest = r.path.length;
      verdict = r.allow;
    }
  }
  return verdict;
}

/* ------------------------------------------------------------------ roles */

type RoleRule = { category: ApprovedRoleCategory; title: RegExp; business: [RegExp, number][] };

const RULES: RoleRule[] = [
  { category: "Data Analyst", title: /\b(?:junior |senior |associate |sr\.? )?data analyst\b/i, business: [[/data analytics|business intelligence|analytics (platform|solutions|services)/i, 2], [/\bpower bi\b|\btableau\b/i, 1]] },
  { category: "Data Engineer", title: /\bdata engineer\b/i, business: [[/data engineering|data platform|big data|data warehouse|data pipeline|\betl\b/i, 2]] },
  { category: "AI Engineer", title: /\b(?:ai engineer|artificial intelligence engineer|generative ai (?:engineer|developer)|llm engineer|prompt engineer)\b/i, business: [[/generative ai|\bgen ?ai\b|\bllms?\b|large language model|artificial intelligence|ai[- ]powered/i, 2]] },
  { category: "AI/ML Engineer", title: /\b(?:ai ?\/ ?ml|ml|machine learning|deep learning|computer vision|nlp) (?:engineer|developer)\b/i, business: [[/machine learning|deep learning|computer vision|natural language processing|\bnlp\b/i, 2]] },
  { category: "AI Applied Engineer", title: /\bapplied (?:ai|ml|machine learning|scientist)\b(?: engineer)?|\bai (?:solutions?|application) engineer\b/i, business: [[/applied ai|conversational ai|ai agents?|ai[- ]driven|ai solutions/i, 2]] },
  { category: "Python Developer", title: /\bpython (?:developer|engineer|programmer)\b/i, business: [[/\bpython\b|\bdjango\b|\bfastapi\b|\bflask\b/i, 1]] },
  { category: "Backend Engineer", title: /\bback[- ]?end (?:developer|engineer)\b/i, business: [[/\bmicroservices?\b|\bbackend\b|cloud[- ]native|api (platform|management|integration)/i, 1], [/\bsaas\b/i, 1]] },
  { category: "Front End Developer / Engineer", title: /\bfront[- ]?end (?:developer|engineer)\b|\bui developer\b/i, business: [[/front[- ]?end|ui\s*\/\s*ux|user experience design|web design/i, 1]] },
  { category: "Full Stack Engineer", title: /\bfull[- ]?stack (?:developer|engineer)\b/i, business: [[/full[- ]?stack|web (application|development|apps?)|digital product/i, 2]] },
  { category: "Software Developer Engineer", title: /\bsoftware development engineer\b|\bsde[- ]?(?:i{1,3}|[1-4])\b/i, business: [[/product engineering|software product/i, 2]] },
  { category: "Software Engineer", title: /\bsoftware (?:engineer|developer)\b/i, business: [[/software (development|engineering|services|solutions|products?|company)|custom software|it services|it consulting/i, 2]] },
  { category: "App Developer", title: /\b(?:mobile|android|ios|flutter|react native|app) (?:app )?(?:developer|engineer)\b/i, business: [[/mobile app|app development|android app|ios app|flutter|react native/i, 2]] },
  { category: "MERN Stack Engineer", title: /\bmern\b|\bnode\.?js (?:developer|engineer)\b/i, business: [[/\bmern\b|\bmongodb\b/i, 2], [/node\.?js/i, 1]] },
];

/** Category priority when scores tie (more specific first). */
const TIE_ORDER = RULES.map((r) => r.category);

const BUSINESS_THRESHOLD = 2;

export function jobTitlesIn(text: string): { category: ApprovedRoleCategory; phrase: string }[] {
  const out: { category: ApprovedRoleCategory; phrase: string }[] = [];
  for (const r of RULES) {
    const g = new RegExp(r.title.source, "gi");
    const seen = new Set<string>();
    for (const m of text.matchAll(g)) {
      const phrase = m[0].replace(/\s+/g, " ").trim();
      const k = phrase.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ category: r.category, phrase });
      if (seen.size >= 3) break;
    }
  }
  return out;
}

/**
 * Chooses a primary role category from what the company's own pages say.
 *  - Verified: a matching job title appears on the fetched careers page (a listing, not just a description of the business).
 *  - Partially Verified: the company's described business/products clearly sit in the category (general indication only).
 *  - Unverified: nothing on the fetched pages justifies an approved category; no category is guessed.
 */
export function assessRole(r: Pick<CompanyResearch, "title" | "description" | "siteName" | "textSample" | "careersUrl" | "careersTitles" | "status">): RoleAssessment {
  if (r.status !== "researched") return { primary: "Unverified", additional: [], status: "Unverified", evidence: "Company website could not be read, so no role evidence exists." };
  const business = [r.title, r.siteName, r.description].filter(Boolean).join(" . ");
  const body = r.textSample ?? "";
  const careers = r.careersTitles ?? [];

  const scored = RULES.map((rule) => {
    const titleHits = careers.filter((t) => rule.title.test(t));
    let biz = 0;
    for (const [re, w] of rule.business) {
      if (re.test(business)) biz += w * 2; // headline/description evidence counts double
      else if (re.test(body)) biz += w;
    }
    return { category: rule.category, titleHits, biz, score: titleHits.length * 10 + biz };
  })
    .filter((s) => s.titleHits.length > 0 || s.biz >= BUSINESS_THRESHOLD)
    .sort((a, b) => b.score - a.score || TIE_ORDER.indexOf(a.category) - TIE_ORDER.indexOf(b.category));

  if (scored.length === 0) {
    return { primary: "Unverified", additional: [], status: "Unverified", evidence: careers.length ? `Careers page lists roles (${careers.slice(0, 3).join("; ")}) but none map to an approved category.` : "No approved role category could be justified from the company's homepage or careers page." };
  }
  const top = scored[0];
  const additional = scored.slice(1, 4).map((s) => s.category);
  if (top.titleHits.length > 0) {
    return {
      primary: top.category,
      additional,
      status: "Verified",
      basis: "careers-listing",
      evidence: `Careers page ${r.careersUrl ?? ""} mentions: ${top.titleHits.slice(0, 3).join("; ")}. (Text seen at fetch time; confirm the opening is still live before applying.)`.replace("  ", " "),
    };
  }
  return {
    primary: top.category,
    additional,
    status: "Partially Verified",
    basis: "company-description",
    evidence: `General indication only: the company's own pages describe ${top.category.toLowerCase()}-type work${r.careersUrl ? `; careers page ${r.careersUrl} lists no matching title` : "; no careers page was found"}. No specific current opening is confirmed.`,
  };
}

/* ------------------------------------------------------------------ company */

function firstSegments(title: string): string[] {
  return title
    .split(/\s[|–—:·-]\s|\s*[|–—]\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= 60);
}

const GENERIC_SEGMENT = /^(home|homepage|welcome|index|main|official site|official website|website)$/i;

const normText = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Decides who owns a domain and how well the contact's stated company is confirmed by it.
 * `claimedCompanies` are the company names the SOURCE FILES gave for contacts at this domain.
 */
export function assessCompany(domain: string, claimedCompanies: readonly string[], r: CompanyResearch | undefined): CompanyAssessment {
  const claimed = [...new Set(claimedCompanies.map((c) => c.trim()).filter(Boolean))];
  const topClaimed = claimed[0] ?? "";
  const base: CompanyAssessment = { name: topClaimed, url: "", domain, status: "Unverified", description: "", careersUrl: "", notes: [] };
  if (!r) {
    base.notes.push("Not researched yet.");
    return base;
  }
  if (r.status !== "researched") {
    const why: Record<CompanyResearch["status"], string> = {
      researched: "",
      unreachable: "The domain did not serve a website (DNS/connection/HTTP failure).",
      parked: "The domain serves a parked/placeholder page, not a company website.",
      "blocked-by-robots": "The site's robots.txt disallows automated access, so it was not read.",
      error: "Fetching the site failed.",
    };
    base.notes.push(`${why[r.status]}${r.error ? ` (${r.error})` : ""} Company name is only what the source files state.`);
    return base;
  }

  const finalDomain = r.finalDomain ?? domain;
  const sameOwner = registrableDomain(finalDomain) === registrableDomain(domain);
  const haystack = normText(`${r.title ?? ""} ${r.siteName ?? ""} ${r.description ?? ""} ${(r.textSample ?? "").slice(0, 3000)}`);
  const label = normText((registrableDomain(domain).split(".")[0] ?? ""));
  const claimedMatch = claimed.find((c) => {
    const k = companyKey(c);
    return k.length >= 3 && haystack.includes(k);
  });
  const labelMatch = label.length >= 4 && haystack.includes(label);

  // Official name: a title/site-name segment that relates to the claimed name or the domain label; else the stated name.
  const segs = [r.siteName ?? "", ...firstSegments(r.title ?? "")].filter((s) => s && !GENERIC_SEGMENT.test(s));
  const related = segs.find((s) => {
    const k = normText(s);
    return (label.length >= 3 && (k.includes(label) || label.includes(k))) || claimed.some((c) => { const ck = companyKey(c); return ck.length >= 3 && (k.includes(ck) || ck.includes(k)); });
  });
  base.name = related ?? topClaimed ?? "";
  base.url = r.finalUrl ?? `https://${domain}`;
  base.description = (r.description ?? "").slice(0, 300);
  base.careersUrl = r.careersUrl ?? "";

  if (!sameOwner) {
    base.status = "Partially Verified";
    base.notes.push(`${domain} redirects to ${finalDomain}, a different registrable domain; ownership link is plausible but not confirmed.`);
  } else if (claimedMatch) {
    base.status = "Verified";
    base.notes.push(`Website at ${domain} names "${claimedMatch}", matching the company stated in the source files.`);
  } else if (claimed.length === 0 && labelMatch) {
    base.status = "Partially Verified";
    base.notes.push("Website is live and carries the domain's brand name, but the source files state no company name to compare.");
  } else if (claimed.length > 0) {
    base.status = "Partially Verified";
    base.notes.push(`Website is live but does not name the stated company (${claimed.slice(0, 2).join(" / ")}); ${labelMatch ? "it does carry the domain's brand name" : "association rests on the e-mail domain only"}.`);
  } else {
    base.status = "Partially Verified";
    base.notes.push("Website is live; no company name in the source files and the page does not clearly name the brand.");
  }
  if (claimed.length > 1 && new Set(claimed.map(companyKey)).size > 1) base.notes.push(`Sources give different company names for this domain: ${claimed.slice(0, 4).join(" | ")}.`);
  return base;
}

/* ------------------------------------------------------------------ people */

export function assessPerson(c: MergedContact, company: CompanyAssessment): { status: Verification; evidence: string; notes: string[] } {
  const where = c.sources.slice(0, 3).map((s) => `${s.file} ${s.location}`).join("; ");
  const evidence = `Listed in ${where}${c.sources.length > 3 ? ` (+${c.sources.length - 3} more)` : ""}. No independent public confirmation of the person was gathered.`;
  const notes: string[] = [];
  if (c.contactKind === "role-mailbox") return { status: "Unverified", evidence, notes: ["Role mailbox: no individual person is named."] };
  if (c.contactKind !== "person") return { status: "Unverified", evidence, notes: ["No usable person name in any source."] };
  if (!c.designation) notes.push("No designation in any source.");
  if (c.emailKind !== "company") notes.push("Public-provider/legacy address: employer cannot be inferred from the address.");
  const files = new Set(c.sources.map((s) => s.file)).size;
  const corroborated = localPartMatchesName(c.email, c.name) || files >= 2;
  const ok = !!c.designation && c.emailKind === "company" && company.status !== "Unverified" && corroborated;
  if (ok) notes.push(files >= 2 ? `Name/designation appear in ${files} independent files.` : "E-mail local part matches the listed name.");
  else if (c.designation && c.emailKind === "company") notes.push("Name/designation rest on a single listing with no corroboration.");
  return { status: ok ? "Partially Verified" : "Unverified", evidence, notes };
}

export function domainOf(url: string): string {
  return normalizeDomain(url);
}

export type { RoleCategoryOrUnverified };

/* ------------------------------------------------------------------ resume / restart */

/** Reads the append-only research log. Later lines for a domain win; a half-written last line is ignored. */
export function parseResearchJsonl(text: string): Map<string, CompanyResearch> {
  const out = new Map<string, CompanyResearch>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as CompanyResearch;
      if (r && typeof r.domain === "string") out.set(r.domain, r);
    } catch {
      /* interrupted write: the domain simply gets researched again */
    }
  }
  return out;
}

/** Domains that still need research: never-researched ones, plus (on request) earlier unreachable/error results. */
export function selectPendingDomains(all: readonly string[], done: ReadonlyMap<string, CompanyResearch>, opts: { retryErrors?: boolean; limit?: number } = {}): string[] {
  const todo = [...new Set(all)].sort().filter((d) => {
    const prev = done.get(d);
    return !prev || (!!opts.retryErrors && (prev.status === "error" || prev.status === "unreachable"));
  });
  return todo.slice(0, opts.limit ?? Infinity);
}
