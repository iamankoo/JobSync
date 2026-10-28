import { ruleVerdict } from "./roles";
import type { JobCandidate } from "./types";

/**
 * Strict eligibility rules for the daily job search. Pure (no I/O): every rule is unit-tested.
 *
 * A job is judged only on what its listing actually says. Nothing is guessed:
 *  - "reject"     the listing states something that rules it out (wrong country/work mode, pay below the minimum,
 *                 a CGPA or backlog requirement, a graduation year without 2027, senior/experienced only, a paid portal);
 *  - "uncertain"  nothing rules it out, but a required fact (country, remote, fresher-eligibility, pay) is not
 *                 stated, so it cannot be treated as qualifying;
 *  - "qualifies"  every rule is satisfied by stated facts. Pay not being disclosed is the one allowed gap, and only
 *                 when the listing is explicitly fresher-friendly (the safe-handling policy, noted on the job).
 */

export type JobKind = "internship" | "full_time";
export type Region = "US" | "IN" | "OTHER";
export type Workplace = "remote" | "hybrid" | "onsite";
export type Verdict = "qualifies" | "uncertain" | "reject";

export const REGIONS: readonly Region[] = ["US", "IN", "OTHER"];

/** Minimum pay, in INR (the user's rule): remote internship ₹30k/month, India on-site internship ₹50k/month, full-time ₹10 LPA. */
export const MIN_STIPEND_REMOTE_MONTHLY_INR = 30_000;
export const MIN_STIPEND_ONSITE_MONTHLY_INR = 50_000;
export const MIN_SALARY_ANNUAL_INR = 1_000_000;

/** Approximate INR per unit, used ONLY to compare a stated amount with the minimums (never stored or shown as pay). */
export const INR_PER_UNIT: Record<string, number> = {
  INR: 1, USD: 85, EUR: 92, GBP: 108, CAD: 62, AUD: 56, SGD: 64, AED: 23, CHF: 98, PLN: 21, SEK: 8.2, NOK: 8, DKK: 12.3, NZD: 51, JPY: 0.57, BRL: 15,
};
const CURRENCY_SYMBOLS: [RegExp, string][] = [
  [/₹|\binr\b|\brs\.?\b|\blpa\b|\blakhs?\b/i, "INR"],
  [/€|\beur\b/i, "EUR"],
  [/£|\bgbp\b/i, "GBP"],
  [/\bcad\b|c\$/i, "CAD"],
  [/\baud\b|a\$/i, "AUD"],
  [/\bsgd\b|s\$/i, "SGD"],
  [/\baed\b/i, "AED"],
  [/\$|\busd\b/i, "USD"],
];

// ---- region ------------------------------------------------------------------------------------------------------

const US_RE = /\b(united states|usa|u\.s\.a?\.?|us[- ]only|remote[- ,(]*us\b|us[- ]remote|new york|san francisco|seattle|austin|boston|chicago|los angeles|denver|atlanta|washington,? d\.?c|california|texas|massachusetts|colorado|north america)\b|,\s?(ny|ca|tx|wa|ma|co|il|ga|fl|va|nc|nj|pa|oh|az|or|ut|mn|mi|dc)\b/i;
const IN_RE = /\b(india|bengaluru|bangalore|hyderabad|pune|mumbai|delhi|new delhi|gurgaon|gurugram|noida|chennai|kolkata|ahmedabad|jaipur|kochi|indore|chandigarh|thiruvananthapuram|coimbatore|vadodara|nagpur|lucknow|bhubaneswar)\b/i;
const OTHER_RE = /\b(united kingdom|uk|england|london|manchester|germany|berlin|munich|hamburg|canada|toronto|vancouver|montreal|ottawa|singapore|australia|sydney|melbourne|netherlands|amsterdam|france|paris|ireland|dublin|spain|madrid|barcelona|portugal|lisbon|poland|warsaw|krakow|italy|milan|rome|sweden|stockholm|norway|oslo|denmark|copenhagen|finland|helsinki|switzerland|zurich|austria|vienna|belgium|brussels|estonia|tallinn|latvia|lithuania|czech|prague|romania|bucharest|hungary|budapest|greece|athens|japan|tokyo|south korea|seoul|uae|united arab emirates|dubai|abu dhabi|israel|tel aviv|brazil|são paulo|sao paulo|mexico|argentina|buenos aires|chile|colombia|new zealand|auckland|south africa|cape town|nigeria|kenya|egypt|turkey|istanbul|hong kong|taiwan|taipei|vietnam|ho chi minh|indonesia|jakarta|philippines|manila|malaysia|kuala lumpur|thailand|bangkok|europe|emea|apac)\b/i;

/**
 * The single country group a listing's location names, or null when it names none or several (e.g. "US or Canada",
 * "Worldwide", "Anywhere"): such a listing cannot be placed in one country bucket.
 */
export function detectRegion(location: string | undefined): Region | null {
  const text = (location ?? "").trim();
  if (!text) return null;
  const hits = new Set<Region>();
  if (US_RE.test(text)) hits.add("US");
  if (IN_RE.test(text)) hits.add("IN");
  if (OTHER_RE.test(text)) hits.add("OTHER");
  return hits.size === 1 ? [...hits][0] : null;
}

// ---- work mode -------------------------------------------------------------------------------------------------

export function detectWorkplace(job: Pick<JobCandidate, "title" | "location" | "remote" | "workplace">): Workplace | null {
  if (job.workplace) return job.workplace;
  const text = `${job.title} ${job.location ?? ""}`;
  if (/\bhybrid\b/i.test(text)) return "hybrid";
  if (job.remote || /\bremote\b|work from home|\bwfh\b|\banywhere\b/i.test(text)) return "remote";
  if (/\bon[- ]?site\b|\bin[- ]office\b|\bin[- ]person\b/i.test(text)) return "onsite";
  return null;
}

// ---- pay -----------------------------------------------------------------------------------------------------------

export interface PayInr {
  /** Highest stated amount, in INR (a range counts by its top: "below the minimum" means even the top is below). */
  monthly: number;
  annual: number;
}

const PERIODS = { hour: { month: 173, year: 2080 }, month: { month: 1, year: 12 }, year: { month: 1 / 12, year: 1 } } as const;

/** Converts a stated amount to INR, or null if the currency is not one we can compare. */
export function payInInr(amount: number, currency: string, period: "year" | "month" | "hour"): PayInr | null {
  const rate = INR_PER_UNIT[currency.toUpperCase()];
  if (!rate || !Number.isFinite(amount) || amount <= 0) return null;
  const p = PERIODS[period];
  return { monthly: amount * rate * p.month, annual: amount * rate * p.year };
}

/** Pay stated in free text, e.g. "₹12-18 LPA", "$80k - $120k", "₹40,000/month", "$25/hour", "unpaid". */
export function parsePayText(text: string): { unpaid: true } | { min?: number; max: number; currency: string; period: "year" | "month" | "hour" } | null {
  const t = text.replace(/\s+/g, " ");
  if (/\bunpaid\b|\bno (stipend|pay|salary)\b|\bvolunteer\b/i.test(t)) return { unpaid: true };
  const currency = CURRENCY_SYMBOLS.find(([re]) => re.test(t))?.[1];
  if (!currency) return null;
  const num = String.raw`(\d{1,3}(?:,\d{2,3})+|\d+(?:\.\d+)?)\s*(?:(k|lpa|lakhs?|l|cr|m)(?![a-z]))?`;
  const range = new RegExp(`${num}\\s*(?:-|–|—|to)\\s*(?:[^\\d]{0,4})?${num}|${num}`, "i").exec(t);
  if (!range) return null;
  const scale = (n: string | undefined, unit: string | undefined) => {
    if (!n) return undefined;
    let v = Number(n.replace(/,/g, ""));
    const u = (unit ?? "").toLowerCase();
    if (u === "k") v *= 1_000;
    else if (u === "lpa" || u === "l" || u.startsWith("lakh")) v *= 100_000;
    else if (u === "cr") v *= 10_000_000;
    else if (u === "m") v *= 1_000_000;
    return v;
  };
  const lo = scale(range[1] ?? range[5], range[2] ?? range[6]);
  const hi = scale(range[3], range[4]) ?? lo;
  if (lo === undefined || hi === undefined) return null;
  // "12-18 LPA": the unit after the second number applies to both.
  const loFixed = range[3] && !range[2] && range[4] ? (scale(range[1], range[4]) ?? lo) : lo;
  const stated: "year" | "month" | "hour" | null = /per hour|\/\s?h(ou)?r|hourly|an hour/i.test(t) ? "hour" : /per month|\/\s?mo(nth)?|monthly|a month|\bpm\b|p\.m\./i.test(t) ? "month" : /lpa|per annum|per year|\/\s?y(ea)?r|annual|a year|\bpa\b/i.test(t) ? "year" : null;
  // No period stated: only an amount that can mean just one thing is used (never guess between monthly and yearly).
  const period = stated ?? (currency === "INR" ? (hi >= 1_000_000 ? "year" : null) : hi >= 1_000 ? "year" : null);
  if (!period) return null;
  return { min: Math.min(loFixed, hi), max: Math.max(loFixed, hi), currency, period };
}

/** The top stated pay of a job in INR, or null when the listing states none (or in a currency we cannot compare). */
export function jobPay(job: Pick<JobCandidate, "salary" | "salaryText">): PayInr | { unpaid: true } | null {
  const s = job.salary;
  if (s && (s.max ?? s.min) && s.currency && s.period) return payInInr((s.max ?? s.min)!, s.currency, s.period);
  if (job.salaryText) {
    const p = parsePayText(job.salaryText);
    if (!p) return null;
    if ("unpaid" in p) return p;
    return payInr(p);
  }
  return null;
}
const payInr = (p: { max: number; currency: string; period: "year" | "month" | "hour" }) => payInInr(p.max, p.currency, p.period);

// ---- text rules ------------------------------------------------------------------------------------------------

const CGPA_RE = /\b(min(imum)?\.?\s*(cgpa|gpa|percentage|aggregate)|(cgpa|gpa)\s*(of|>=|≥|above|over|:|\d)|\d(\.\d+)?\+?\s*(cgpa|gpa)\b|(60|65|70|75|80)\s*%\s*(and above|or above|\+|throughout|aggregate|in (10th|12th|graduation|b\.?tech))|(first|1st) class)/i;
const BACKLOG_RE = /\b(no (active |standing |current |pending )?(backlogs?|arrears)|without (any )?(active )?(backlogs?|arrears)|backlogs?[- ]free|zero (active )?backlogs?|(should|must) not have (any )?(active )?(backlogs?|arrears)|no (history of )?(backlogs?|arrears)|(backlogs?|arrears) (are )?not (allowed|permitted))\b/i;
const EXPERIENCED_ONLY_RE = /\b(experienced (candidates|professionals) only|not (open|suitable) (to|for) (freshers|fresh graduates|students)|no freshers|freshers (need not|should not) apply|prior (industry|professional|work) experience (is )?(required|mandatory))\b/i;
const FRESHER_RE = /\b(freshers?|fresh graduates?|new[- ]grads?|new graduates?|recent graduates?|graduate (program|programme|role|engineer|developer)|entry[- ]level|early[- ]career|campus|0\s*[-–to]+\s*[12]\s*(\+\s*)?years?|(zero|no) (prior )?(work |industry |professional )?experience|2027 (batch|graduat|grads?|pass(ing)?[- ]?out)|class of 2027|graduating in 2027|(batch|graduation|passing out|pass-?out)( year| of)?:?\s*2027)\b/i;
const GRAD_CONTEXT_RE = /(batch|graduat\w*|pass(?:ing)?[- ]?outs?|class of|degree|alumni)[^.\n]{0,60}?\b(20[12]\d)(?:\s*(?:[,/&-]|and|or|to)\s*(20[12]\d))*/gi;

/** Graduation years the listing names in a graduation/batch context. */
export function graduationYears(text: string): number[] {
  const years = new Set<number>();
  for (const m of text.matchAll(GRAD_CONTEXT_RE)) for (const y of m[0].match(/20[12]\d/g) ?? []) years.add(Number(y));
  // "2025/2026 batch", "2024, 2025 and 2026 graduates"
  for (const m of text.matchAll(/\b((?:20[12]\d)(?:\s*(?:[,/&-]|and|or|to)\s*20[12]\d)*)\s*(?:batch|graduat\w*|pass(?:ing)?[- ]?outs?)/gi)) for (const y of m[1].match(/20[12]\d/g) ?? []) years.add(Number(y));
  return [...years];
}

/** Lowest years of professional experience the listing requires, or null when it states none. */
export function requiredExperienceYears(text: string): number | null {
  let min: number | null = null;
  for (const m of text.matchAll(/(\d{1,2})\s*\+?\s*(?:[-–to]+\s*\d{1,2}\s*\+?\s*)?(?:years?|yrs?)(?:\s+of)?\s+(?:(?:relevant|professional|industry|hands-on|work|commercial|software|engineering|development|prior|proven)\s+){0,3}(?:experience|exp\b)/gi)) {
    const n = Number(m[1]);
    if (min === null || n < min) min = n;
  }
  return min;
}

const PAID_TEXT_RE = /\b(registration fee|application fee|processing fee|placement fee|training fee|admission fee|security deposit|refundable deposit|pay (a |the )?(fee )?(to|for) (apply|applying|application|this (job|role))|apply for (a )?fee|fee (is )?(required|applicable|payable)|premium (membership|subscription|plan) (to|for) apply|subscribe to apply|unlock (this )?(job|application)|upgrade to apply|job guarantee|guaranteed (job|placement)|pay after (placement|job)|resume (writing|building|review) (service|package)|buy (our |the )?(course|package|plan)|enroll(ment)? fee|paid (training|certification) (program|course) (required|mandatory))\b/i;
const PAID_URL_RE = /\/(checkout|payment|pay-to-apply|subscribe|premium|pricing|upgrade)(\/|\?|$)|[?&](affiliate|aff|ref_pay|coupon)=/i;

/** Pay-to-apply funnels and services that merely sell access to jobs. */
export function isPaidPortal(job: Pick<JobCandidate, "url" | "title" | "description" | "source">): string | null {
  if (PAID_URL_RE.test(job.url)) return "the link leads to a payment / subscription page";
  const hit = PAID_TEXT_RE.exec(`${job.title} ${job.description ?? ""}`);
  return hit ? `the listing asks for a payment ("${hit[0].toLowerCase()}")` : null;
}

// ---- source quality -----------------------------------------------------------------------------------------------

export type SourceTier = "official" | "linkedin" | "open";

const OFFICIAL_SOURCES = /^(greenhouse|lever|ashby|workable|smartrecruiters|company careers?)/i;
const slug = (s: string) => s.toLowerCase().replace(/\b(inc|llc|ltd|limited|corp|gmbh|labs?|technologies|ai)\b/g, "").replace(/[^a-z0-9]/g, "");

/**
 * Official company career page / official ATS board first, LinkedIn second, other open sources last.
 * A job on another site counts as official only when its link is on the company's own domain.
 */
export function sourceTier(job: Pick<JobCandidate, "source" | "url" | "companyName">): SourceTier {
  if (OFFICIAL_SOURCES.test(job.source)) return "official";
  let host = "";
  try {
    host = new URL(job.url).hostname.toLowerCase();
  } catch {
    return "open";
  }
  if (/(^|\.)(boards\.greenhouse\.io|job-boards\.greenhouse\.io|jobs\.lever\.co|jobs\.ashbyhq\.com|apply\.workable\.com|careers\.smartrecruiters\.com)$/.test(host)) return "official";
  const key = slug(job.companyName);
  if (key.length >= 4 && host.replace(/^www\./, "").split(".").some((p) => slug(p) === key) && !/(remoteok|arbeitnow|linkedin|indeed|glassdoor|jooble|careerjet)/.test(host)) return "official";
  if (/(^|\.)linkedin\.com$/.test(host) || /^linkedin/i.test(job.source)) return "linkedin";
  return "open";
}
export const TIER_RANK: Record<SourceTier, number> = { official: 3, linkedin: 2, open: 1 };

// ---- the verdict ---------------------------------------------------------------------------------------------------

export interface JobEvaluation {
  verdict: Verdict;
  /** Why (for a reject: every stated reason; for uncertain: what could not be established). */
  reasons: string[];
  region: Region | null;
  workplace: Workplace | null;
  tier: SourceTier;
  /** True when pay was stated and met the minimum. */
  payVerified: boolean;
  /** Short notes saved on the job (what was established and what was not). */
  notes: string[];
}

export function evaluateJob(job: JobCandidate, kind: JobKind): JobEvaluation {
  const rejects: string[] = [];
  const unknown: string[] = [];
  const notes: string[] = [];
  const text = `${job.title}\n${job.description ?? ""}`;
  const tier = sourceTier(job);
  const region = detectRegion(job.location);
  const workplace = detectWorkplace(job);

  const portal = isPaidPortal(job);
  if (portal) rejects.push(`paid portal: ${portal}`);

  // The role itself: a software/data role for a fresher.
  const role = ruleVerdict(job.title);
  if (role.verdict === "irrelevant") rejects.push(`role not suitable (${role.reason})`);
  // "unsure" titles are decided afterwards by the brain (as for every saved job), not here.

  // Eligibility stated in the listing.
  if (CGPA_RE.test(text)) rejects.push("requires a minimum CGPA / percentage");
  if (BACKLOG_RE.test(text)) rejects.push("has a backlog restriction");
  if (EXPERIENCED_ONLY_RE.test(text)) rejects.push("experienced candidates only");
  const years = graduationYears(text);
  if (years.length && !years.includes(2027)) rejects.push(`only for the ${years.join("/")} graduation batch(es)`);
  const exp = requiredExperienceYears(text);
  if (exp !== null && exp >= 2) rejects.push(`requires ${exp}+ years of experience`);
  else if (exp === 1) unknown.push("asks for 1+ year of experience");
  const fresherFriendly = FRESHER_RE.test(text) || years.includes(2027) || kind === "internship" || /\b(junior|jr\.?|associate|trainee|graduate)\b/i.test(job.title);
  if (!fresherFriendly) unknown.push("does not say freshers / the 2027 batch are eligible");
  else if (years.includes(2027)) notes.push("lists the 2027 batch");

  // Country and work mode.
  if (!region) unknown.push("country not stated clearly");
  if (region === "US" || region === "OTHER") {
    if (workplace && workplace !== "remote") rejects.push(`${region === "US" ? "US" : "non-US/India"} jobs must be remote (this is ${workplace})`);
    else if (!workplace) unknown.push("remote not stated");
  }
  if (region === "IN" && kind === "internship" && !workplace) notes.push("work mode not stated (treated as on-site)");

  // Pay.
  const pay = jobPay(job);
  let payVerified = false;
  if (pay && "unpaid" in pay) rejects.push("unpaid");
  else if (pay) {
    const onsiteIndia = region === "IN" && workplace !== "remote";
    if (kind === "internship") {
      const min = onsiteIndia ? MIN_STIPEND_ONSITE_MONTHLY_INR : MIN_STIPEND_REMOTE_MONTHLY_INR;
      if (pay.monthly < min) rejects.push(`stipend about ₹${Math.round(pay.monthly).toLocaleString("en-IN")}/month is below ₹${min.toLocaleString("en-IN")}`);
      else payVerified = true;
    } else if (pay.annual < MIN_SALARY_ANNUAL_INR) rejects.push(`pay about ₹${Math.round(pay.annual / 100_000)} LPA is below ₹10 LPA`);
    else payVerified = true;
  } else if (job.salary || job.salaryText) unknown.push("pay is in a form that cannot be compared");
  else {
    // Safe handling: pay not disclosed. Allowed only for an explicitly fresher-friendly, official-source listing.
    if (fresherFriendly && tier === "official") notes.push("pay not disclosed in the listing");
    else unknown.push("pay not disclosed");
  }
  if (payVerified) notes.push("pay meets the minimum");

  const verdict: Verdict = rejects.length ? "reject" : unknown.length ? "uncertain" : "qualifies";
  return { verdict, reasons: rejects.length ? rejects : unknown, region, workplace, tier, payVerified, notes };
}
