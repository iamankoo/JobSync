import { TEMPLATES_BY_ID } from "@/config/email-templates";
import { MEMBER_EMAIL_PROFILES } from "@/config/member-email-profiles";
import { MEMBER_IDS, type MemberId } from "@/config/members";
import { TECH_CATEGORIES, getSkill, type Skill } from "@/config/skills";
import { matchTemplate, mentions, type EmailJob } from "./email-composer";
import { TIER_RANK, type JobEvaluation, type JobKind, type Region } from "./job-eligibility";
import { matchRole } from "./roles";
import type { JobCandidate } from "./types";

/**
 * Which member a qualifying job suits, and the daily split: per kind (internship / full-time) up to 5 US + 5 India +
 * 5 other-country jobs, and up to 5 for each member. Quality comes first: a bucket stays short rather than taking a
 * job that does not fit. Pure, so the whole allocation is unit-tested.
 */

export const PER_REGION = 5;
export const PER_MEMBER = 5;

export interface MemberFit {
  memberId: MemberId;
  /** Higher is better. 0 = the member's verified skills give no match ("insufficient"): this ranks them lower, it never excludes them. */
  score: number;
  /** The member's own verified skills that the job asks for (for the saved note). */
  matched: string[];
}

const techSkill = (k: Skill | undefined): k is Skill => Boolean(k) && TECH_CATEGORIES.includes(k!.category);

/**
 * Fit between a job and a member's VERIFIED skills (config/member-email-profiles.ts) — never the whole 200-skill
 * taxonomy. A job fits when it names at least one of the member's verified technologies, or when its role family
 * clearly sits on the member's strengths (≥ 2 of the family's priority skills are verified for them). A member
 * with no verified skills fits nothing.
 */
export function memberFit(memberId: MemberId, job: Pick<JobCandidate, "title" | "description">): MemberFit {
  const own = MEMBER_EMAIL_PROFILES[memberId].skills.map(getSkill).filter(techSkill);
  if (own.length === 0) return { memberId, score: 0, matched: [] };
  const text = `${job.title} ${job.description ?? ""}`;
  const matched = own.filter((k) => [k.name, ...k.aliases].some((p) => mentions(text, p)));
  // Role strength counts only when the title / description really point to a role family (no default applied).
  const templateId = matchTemplate(job.title, job.description);
  const ownIds = new Set(own.map((k) => k.id));
  const roleStrength = templateId ? TEMPLATES_BY_ID.get(templateId)!.prioritySkills.filter((s) => ownIds.has(s)).length : 0;
  if (matched.length === 0 && roleStrength < 2) return { memberId, score: 0, matched: [] };
  const score = matched.length * 10 + roleStrength * 3 + Math.round(matchRole(job.title).score / 10);
  return { memberId, score, matched: matched.slice(0, 8).map((k) => k.name) };
}

export interface EvaluatedJob {
  job: JobCandidate;
  evaluation: JobEvaluation & { region: Region };
}

export interface Assignment {
  job: JobCandidate;
  memberId: MemberId;
  region: Region;
  fit: MemberFit;
  evaluation: JobEvaluation;
}

export interface Capacity {
  /** Jobs already saved today per region / per member (this kind). */
  regionUsed: Partial<Record<Region, number>>;
  memberUsed: Partial<Record<MemberId, number>>;
  /** Companies already used today (lower-case), so a company never gets a second opening in the same kind. */
  companiesUsed: ReadonlySet<string>;
}

const companyKey = (j: JobCandidate) => j.companyName.trim().toLowerCase();

/**
 * Greedy best-first assignment: the best (official source, then fit) job/member pairs first, each job once, each
 * company once, never beyond 5 per region or 5 per member. ELIGIBILITY IS THE SAME FOR EVERY MEMBER: a job in
 * `candidates` already passed the common rules (evaluateJob), whatever a member's profile holds. A member's verified
 * skills only RANK the pairs (best fit first) and are never a condition: an empty or partial profile is a low match,
 * not an exclusion. Buckets stay below 5 only when too few jobs pass the common rules.
 */
export function allocate(candidates: readonly EvaluatedJob[], capacity: Capacity, members: readonly MemberId[] = MEMBER_IDS, perRegion = PER_REGION, perMember = PER_MEMBER): Assignment[] {
  const pairs = candidates.flatMap((c) =>
    members.map((m) => ({ c, fit: memberFit(m, c.job) })).map((p) => ({ ...p, rank: TIER_RANK[c.evaluation.tier] * 1000 + p.fit.score + (c.evaluation.payVerified ? 25 : 0) })),
  );
  pairs.sort((a, b) => b.rank - a.rank);
  const regionLeft = (r: Region) => perRegion - (capacity.regionUsed[r] ?? 0);
  const memberLeft = (m: MemberId) => perMember - (capacity.memberUsed[m] ?? 0);
  const taken = new Set<JobCandidate>();
  const companies = new Set(capacity.companiesUsed);
  const out: Assignment[] = [];
  for (const { c, fit } of pairs) {
    const region = c.evaluation.region;
    if (taken.has(c.job) || companies.has(companyKey(c.job)) || regionLeft(region) <= 0 || memberLeft(fit.memberId) <= 0) continue;
    taken.add(c.job);
    companies.add(companyKey(c.job));
    capacity.regionUsed[region] = (capacity.regionUsed[region] ?? 0) + 1;
    capacity.memberUsed[fit.memberId] = (capacity.memberUsed[fit.memberId] ?? 0) + 1;
    out.push({ job: c.job, memberId: fit.memberId, region, fit, evaluation: c.evaluation });
  }
  return out;
}

export const kindSlug = (kind: JobKind) => (kind === "internship" ? "internship" : "full-time");
export const regionSlug = (r: Region) => r.toLowerCase();
/** Ledger keys (NF_State): today's total per kind (existing), per region and per member. */
export const jobLedgerKeys = (day: string, kind: JobKind) => ({
  total: `${day}#jobs-${kindSlug(kind)}`,
  region: (r: Region) => `${day}#jobs-${kindSlug(kind)}-region-${regionSlug(r)}`,
  member: (m: MemberId) => `${day}#jobs-${kindSlug(kind)}-member-${m}`,
});


/**
 * The company's open role that best fits THIS member, from jobs that really exist (Jobs sheet, or the company's own
 * careers board). Senior / non-engineering roles are never picked. A member with verified skills only gets a role
 * those skills fit; a member with none can be pointed at the best early-career role (the email then claims no skills).
 * Undefined means no genuine match, and the email speaks of the role family instead of inventing an opening.
 */
export function pickJobForMember(memberId: MemberId, jobs: readonly EmailJob[]): EmailJob | undefined {
  const hasSkills = MEMBER_EMAIL_PROFILES[memberId].skills.some((s) => techSkill(getSkill(s)));
  let best: { job: EmailJob; score: number } | undefined;
  for (const job of jobs) {
    const role = matchRole(job.title);
    if (!role.relevant) continue;
    const fit = memberFit(memberId, job);
    if (hasSkills && fit.score === 0) continue;
    const score = fit.score * 10 + role.score + (job.description ? 5 : 0);
    if (!best || score > best.score) best = { job, score };
  }
  return best?.job;
}
