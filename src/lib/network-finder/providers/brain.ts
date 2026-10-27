import { classifyPersona } from "../contacts";
import { selectCompanies } from "../qualify";
import { matchRole } from "../roles";
import { PERSONAS, type JobCandidate, type PersonCandidate, type QualifiedCompany } from "../types";

/**
 * The "brain" decides what is worth doing and writes draft text. It NEVER sends anything: its only outputs
 * are choices among candidates it was given, relevance verdicts, and draft text that a member reviews.
 *
 * Guardrails every implementation must keep (and the Nemotron adapter enforces in code):
 *  - choices are restricted to the candidates passed in (no invented companies, people or jobs);
 *  - hard rules stay in code: size tiers, target countries, 70/30 split, de-duplication, quotas;
 *  - a failed decision falls back to the rule-based brain; a failed draft is retried later, never faked.
 */
export interface DraftRequest {
  kind: "outreach" | "job_application";
  /** The member the draft is written for (their own Gmail). */
  member: { id: string; name: string; profile?: string };
  company: { name: string; website?: string; description?: string };
  person?: { name: string; title: string };
  job?: { title: string; url: string; location?: string };
}

export interface DraftContent {
  subject: string;
  body: string;
}

export interface Brain {
  readonly id: string;
  /** Up to `n` companies worth targeting, chosen ONLY from `candidates` (size tier and 70/30 still apply). */
  prioritizeCompanies(candidates: readonly QualifiedCompany[], n: number): Promise<QualifiedCompany[]>;
  /** People worth enriching, in order, chosen ONLY from `people`. */
  choosePeople(company: QualifiedCompany, people: readonly PersonCandidate[], max: number): Promise<PersonCandidate[]>;
  isRelevantJob(job: JobCandidate): Promise<{ relevant: boolean; reason: string }>;
  writeDraft(request: DraftRequest): Promise<DraftContent>;
}

/** Deterministic rules (the fallback, and the default until Nemotron is configured). */
export const ruleBrain: Brain = {
  id: "rules",
  async prioritizeCompanies(candidates, n) {
    return selectCompanies(candidates, n);
  },
  async choosePeople(_company, people, max) {
    const rank = (t: string) => {
      const p = classifyPersona(t);
      return p ? PERSONAS.indexOf(p) : -1;
    };
    return people.filter((p) => rank(p.title) >= 0).sort((a, b) => rank(a.title) - rank(b.title)).slice(0, max);
  },
  async isRelevantJob(job) {
    const m = matchRole(job.title);
    return { relevant: m.relevant, reason: m.reason };
  },
  async writeDraft(r) {
    const greeting = r.person ? `Hi ${r.person.name.split(" ")[0]},` : "Hello,";
    const about = r.job ? `the ${r.job.title} role at ${r.company.name}` : `opportunities at ${r.company.name}`;
    return {
      subject: r.job ? `Application: ${r.job.title} — ${r.member.name}` : `Interested in ${r.company.name}`,
      body: `${greeting}\n\nI'm ${r.member.name}, and I'm very interested in ${about}.${r.member.profile ? `\n\n${r.member.profile}` : ""}\n\nWould you be open to a short conversation?\n\nBest regards,\n${r.member.name}`,
    };
  },
};
