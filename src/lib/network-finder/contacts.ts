import { matchRole } from "./roles";
import { PERSONAS, type EnrichedPerson, type Persona, type RankedPerson } from "./types";

/** How many people to save per newly discovered company (the eventual target). */
export const PEOPLE_PER_COMPANY = 3;

const RECRUITER = /\b(recruit\w*|talent|sourcer|people (partner|operations|ops)|human resources|hr\b|hrbp)/i;
const LEADER = /\b(founder|co-?founder|ceo|cto|coo|cpo|chief|president|owner|managing director|general manager)\b/i;
const HIRING_MANAGER = /\b(engineering manager|head of (engineering|data|ai|ml|product|technology)|director of (engineering|data|ai|technology)|vp (of )?(engineering|data|technology)|tech lead|team lead|lead engineer|engineering lead)\b/i;

/** Who this person is to us, from their title; null if they are not someone worth contacting. */
export function classifyPersona(title: string): Persona | null {
  if (RECRUITER.test(title)) return "recruiter";
  if (HIRING_MANAGER.test(title)) return "hiring_manager";
  if (LEADER.test(title)) return "leader";
  // A peer in one of our target roles can refer us (seniority does not matter for a referral).
  const m = matchRole(title.replace(/\b(senior|sr\.?|staff|principal|lead)\b/gi, ""));
  return m.relevant ? "referrer" : null;
}

const PERSONA_RANK = Object.fromEntries(PERSONAS.map((p, i) => [p, i])) as Record<Persona, number>;

/**
 * Orders people by persona priority (recruiter → hiring manager → founder/leadership → referrer), preferring
 * reachable ones (verified email, then any email, then a profile URL), and returns the top `limit`.
 * People we cannot reach at all, or whose role does not matter to us, are left out.
 */
export function rankPeople(people: readonly EnrichedPerson[], limit: number = PEOPLE_PER_COMPANY): RankedPerson[] {
  // Verified or published addresses first, then unverified / predicted ones, then a profile URL only.
  const reach = (p: EnrichedPerson) => (p.email && (p.emailStatus === "verified" || p.emailStatus === "public") ? 0 : p.email ? 1 : p.linkedinUrl ? 2 : 3);
  return people
    .map((p) => ({ ...p, persona: classifyPersona(p.title) }))
    .filter((p): p is RankedPerson => p.persona !== null && reach(p) < 3 && p.name.trim().length > 0)
    .sort((a, b) => PERSONA_RANK[a.persona] - PERSONA_RANK[b.persona] || reach(a) - reach(b) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export const PERSONA_LABEL: Record<Persona, string> = {
  recruiter: "Recruiter / Talent",
  hiring_manager: "Hiring manager",
  leader: "Founder / leadership",
  referrer: "Potential referrer",
};
