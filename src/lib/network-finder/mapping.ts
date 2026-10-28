import { parseHttpUrl } from "@/lib/utils/url";
import { isEmailAddress } from "@/lib/validation/connections";
import { PERSONA_LABEL } from "./contacts";
import { classifyEmployment } from "./roles";
import type { JobCandidate, QualifiedCompany, RankedPerson } from "./types";

/**
 * Converts pipeline candidates into the EXACT inputs the existing services accept (the same shapes the
 * Connections and Add Job forms send). The gateways then validate them with the services' own schemas.
 */

const clip = (s: string | undefined, max: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max).trimEnd() : t;
};
const url = (u: string | undefined) => (u && parseHttpUrl(u) ? u.trim() : undefined);

export interface ConnectionInput {
  name: string;
  company?: string;
  role?: string;
  email?: string;
  profileUrl?: string;
  otherUrl?: string;
  notes?: string;
  status: "Not Connected";
}

/** How the email was obtained, in words a member reads before sending. A predicted address is never called verified. */
export function emailNote(p: Pick<RankedPerson, "email" | "emailStatus" | "emailSource">): string {
  if (!p.email?.trim()) return "Email: not available";
  switch (p.emailStatus) {
    case "verified": return `Email: verified${p.emailSource ? ` (${p.emailSource})` : ""}`;
    case "public": return `Email: public — published on ${p.emailSource ?? "a public page"}`;
    case "predicted": return `Email: Predicted / Unverified — VERIFY BEFORE SENDING${p.emailSource ? ` (${p.emailSource})` : ""}`;
    default: return `Email: unverified${p.emailSource ? ` (${p.emailSource})` : ""}`;
  }
}

export interface ConnectionExtras {
  /** Today's selected contact for this company: who follows them up (drafts still go to all three members). */
  assignedTo?: string;
}

/** A discovered person as a new Connections entry. The "Message to send" field is left empty. */
export function toConnectionInput(p: RankedPerson, company: QualifiedCompany, discoveredOn: string, extras: ConnectionExtras = {}): ConnectionInput {
  const email = p.email?.trim();
  const profileUrl = url(p.linkedinUrl);
  const otherUrl = url(p.otherUrl) ?? url(company.website);
  const phone = p.phone?.replace(/\s+/g, " ").trim();
  const notes = [
    `Source: Network Finder — ${company.source.toUpperCase()}${company.sourceUrl ? ` (${company.sourceUrl})` : ""} → ${p.provider}${p.sourceUrl && p.sourceUrl !== company.sourceUrl ? ` (${p.sourceUrl})` : ""}`,
    `Discovered: ${discoveredOn}`,
    `Type: ${PERSONA_LABEL[p.persona]}`,
    emailNote(p),
    ...(phone ? [`Phone: ${phone} (published${p.sourceUrl ? ` on ${p.sourceUrl}` : ""})`] : []),
    ...(extras.assignedTo ? [`Assigned to: ${extras.assignedTo} (today's outreach)`] : []),
    "Drafts: one in each member's Gmail (review before sending; nothing is sent automatically)",
    `Company: ${company.reasons.join(", ")}`,
  ].join("\n");
  return {
    name: clip(p.name, 120),
    company: clip(company.name, 120) || undefined,
    role: clip(p.title, 120) || undefined,
    ...(email && isEmailAddress(email) ? { email } : {}),
    ...(profileUrl ? { profileUrl } : {}),
    ...(otherUrl && otherUrl !== profileUrl ? { otherUrl } : {}),
    notes: notes.length > 2000 ? notes.slice(0, 2000) : notes,
    status: "Not Connected",
  };
}

export interface JobInput {
  company: string;
  jobRole: string;
  jobType: "Internship" | "Full-time" | "Part-time" | "Contract";
  workMode?: "Remote" | "Hybrid" | "On-site";
  experience?: string;
  stipendSalary?: string;
  location: string;
  jobUrl: string;
  description?: string;
}

const JOB_TYPE = { internship: "Internship", full_time: "Full-time", part_time: "Part-time", contract: "Contract" } as const;

/** A discovered posting as a new Jobs row. Location falls back to "Remote" / "Not specified", never a guess. */
export function toJobInput(j: JobCandidate, discoveredOn: string, extra: { assignedTo?: string; notes?: readonly string[]; workplace?: "remote" | "hybrid" | "onsite" | null; pay?: string } = {}): JobInput {
  const location = clip(j.location, 120) || (j.remote ? "Remote" : "Not specified");
  const source = `Found by Network Finder via ${j.source} on ${discoveredOn}.${extra.assignedTo ? ` Best match for ${extra.assignedTo}.` : ""}${extra.notes?.length ? ` ${extra.notes.join("; ")}.` : ""}`;
  const mode = extra.workplace === "hybrid" ? ("Hybrid" as const) : extra.workplace === "onsite" ? ("On-site" as const) : extra.workplace === "remote" || j.remote ? ("Remote" as const) : undefined;
  return {
    company: clip(j.companyName, 120),
    jobRole: clip(j.title, 160),
    jobType: JOB_TYPE[classifyEmployment(j.title, j.employment)],
    ...(mode ? { workMode: mode } : {}),
    ...(extra.pay ? { stipendSalary: clip(extra.pay, 80) } : {}),
    location,
    jobUrl: j.url.trim(),
    description: clip(`${source}${j.description ? ` ${j.description}` : ""}`, 5000),
  };
}
