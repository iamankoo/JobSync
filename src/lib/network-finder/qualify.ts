import { companyKey, domainOf } from "./dedupe";
import { INTERNATIONAL_COUNTRIES, type CompanyCandidate, type QualifiedCompany, type Qualification, type SizeTier, type TargetCountry } from "./types";

export const SIZE_TIERS: readonly SizeTier[] = [25, 100, 250];
/** Share of each batch reserved for US companies (the rest: the international target countries). */
export const US_SHARE = 0.7;

const FRESHER_SIGNAL = /\b(interns?|internships?|new grads?|graduates?|junior|entry[\s-]level|freshers?|campus|early[\s-]career)\b/i;

function targetCountry(code: string | undefined): TargetCountry | null {
  if (!code) return null;
  const c = code.trim().toUpperCase() === "UK" ? "GB" : code.trim().toUpperCase();
  if (c === "US") return "US";
  return (INTERNATIONAL_COUNTRIES as readonly string[]).includes(c) ? (c as TargetCountry) : null;
}

/**
 * Decides whether a company is worth pursuing and how well it fits. Only facts the source reported are
 * used; a company with an unknown size or country is rejected rather than guessed.
 */
export function qualifyCompany(c: CompanyCandidate): Qualification {
  if (!c.name.trim()) return { qualified: false, reason: "no company name" };
  if (c.employeeCount === undefined || !Number.isFinite(c.employeeCount) || c.employeeCount < 1) return { qualified: false, reason: "employee count unknown" };
  const sizeTier = SIZE_TIERS.find((t) => c.employeeCount! <= t);
  if (!sizeTier) return { qualified: false, reason: `too large (${c.employeeCount} employees)` };
  const country = targetCountry(c.countryCode);
  if (!country) return { qualified: false, reason: c.countryCode ? `country ${c.countryCode} is not targeted` : "country unknown" };

  const reasons = [`${c.employeeCount} employees (≤${sizeTier})`, country === "US" ? "US" : `international (${country})`, ...(c.factsSource ? [c.factsSource] : [])];
  let score = 0;
  if (c.remoteFriendly) {
    score += 30;
    reasons.push("remote-friendly");
  }
  if (c.hiring) {
    score += 25;
    reasons.push("hiring");
  }
  const text = [c.description, ...(c.tags ?? [])].filter(Boolean).join(" ");
  if (FRESHER_SIGNAL.test(text)) {
    score += 20;
    reasons.push("fresher-friendly signals");
  }
  const domain = domainOf(c.website);
  return {
    qualified: true,
    company: { ...c, key: companyKey(c), ...(domain ? { domain } : {}), country, regionGroup: country === "US" ? "us" : "international", sizeTier, score, reasons },
  };
}

/**
 * The day's size plan: companies 1–30 must have 1–25 employees, 31–40 up to 100, 41–50 up to 250.
 * `index` is the company's 0-based position in the day.
 */
export const DAILY_TIER_PLAN: readonly { upTo: number; maxTier: SizeTier }[] = [
  { upTo: 30, maxTier: 25 },
  { upTo: 40, maxTier: 100 },
  { upTo: Number.POSITIVE_INFINITY, maxTier: 250 },
];
export const tierCapFor = (index: number): SizeTier => DAILY_TIER_PLAN.find((p) => index < p.upTo)!.maxTier;

/**
 * Fills the next `n` slots of the day (starting at the day's position `startIndex`), each slot capped by the
 * tier plan, ~70% US / ~30% international, best score first. A slot with no fitting company stays EMPTY rather
 * than being filled with a company that breaks the plan.
 */
export function planBatch(candidates: readonly QualifiedCompany[], startIndex: number, n: number, usShare: number = US_SHARE): QualifiedCompany[] {
  const remaining = [...new Map(candidates.map((c) => [c.key, c])).values()].sort((a, b) => b.score - a.score || a.sizeTier - b.sizeTier || a.name.localeCompare(b.name));
  const intlShare = 1 - usShare;
  const picked: QualifiedCompany[] = [];
  for (let i = 0; i < n; i++) {
    const cap = tierCapFor(startIndex + i);
    const wantIntl = Math.floor((i + 1) * intlShare + 1e-9) > Math.floor(i * intlShare + 1e-9);
    const fits = (c: QualifiedCompany) => c.sizeTier <= cap;
    const idx = remaining.findIndex((c) => fits(c) && (c.regionGroup === "international") === wantIntl);
    const any = idx >= 0 ? idx : remaining.findIndex(fits);
    if (any < 0) continue;
    picked.push(remaining.splice(any, 1)[0]);
  }
  return picked;
}

/**
 * Picks up to `n` companies: smaller size tiers first (1–25, then 1–100, then 1–250), best score within a
 * tier, and ~70% US / ~30% international. If one group runs short, the other fills the gap so a batch is
 * not left empty for lack of balance.
 */
export function selectCompanies(candidates: readonly QualifiedCompany[], n: number, usShare: number = US_SHARE): QualifiedCompany[] {
  const order = (a: QualifiedCompany, b: QualifiedCompany) => a.sizeTier - b.sizeTier || b.score - a.score || a.name.localeCompare(b.name);
  const unique = [...new Map(candidates.map((c) => [c.key, c])).values()];
  const us = unique.filter((c) => c.regionGroup === "us").sort(order);
  const intl = unique.filter((c) => c.regionGroup === "international").sort(order);
  const usTarget = Math.round(n * usShare);
  const picked = [...us.slice(0, usTarget), ...intl.slice(0, n - usTarget)];
  // Fill any shortfall from whichever group still has companies.
  const rest = [...us.slice(usTarget), ...intl.slice(n - usTarget)].sort(order);
  for (const c of rest) {
    if (picked.length >= n) break;
    picked.push(c);
  }
  return picked.slice(0, n);
}
