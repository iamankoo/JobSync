import type { MemberId } from "./members";

/**
 * Which uploaded resume goes on a connection's Gmail draft, for ALL three members.
 *
 * A resume is always the member's OWN upload (every lookup is scoped to the member id), matched by EXACT file name (ignoring
 * case) against that member's uploads in Profile -> My Resumes. The target role picks a resume KIND; the kind picks the file:
 *
 *   AI / ML / AI Engineer ............ AIML      Software Engineer / SDE / Backend / Python ... SDE
 *   Front End / Full Stack / Web ..... WebD      DevOps ................................... DevOps
 *   Data Engineer / Scientist / Analyst  Data
 *
 * If the member has no file for the specialised kind (or that file is ambiguous/unreadable), the SAME member's SDE resume is
 * used and the draft records why. If even the SDE resume is unavailable, the draft is created WITHOUT an attachment and
 * flagged for review. Another member's resume is never a candidate. To add a resume later, add its exact name below.
 */
export type ResumeKind = "AIML" | "SDE" | "WebD" | "DevOps" | "Data";
export const RESUME_KINDS: readonly ResumeKind[] = ["AIML", "SDE", "WebD", "DevOps", "Data"];

/** Exact upload names per member and kind (as of the 3 Nov 2026 inventory of Profile -> My Resumes). A missing kind = no such upload. */
export const MEMBER_RESUME_FILES: Record<MemberId, Partial<Record<ResumeKind, string>>> = {
  // Aniket Raj. Also uploaded but deliberately NOT mapped (not role resumes): Aniket_Raj_AI_2.pdf (a second AI variant, ambiguous
  // next to the AIML file), and the company-specific Aniket_Raj_Nokia.pdf, Aniket_Raj_So.pdf, Aniket_Raj_Cognizant_Ace.pdf.
  anni: {
    AIML: "Aniket-Raj-AIML.pdf",
    SDE: "Aniket_Raj_SDE.pdf",
    WebD: "Aniket_Raj_WebD.pdf",
    DevOps: "Aniket_Raj_DevOps.pdf",
    Data: "Aniket_Raj_Data.pdf",
  },
  // Lakshya Singh: only SDE and AI/ML resumes are uploaded (WebD, DevOps, Data fall back to his SDE resume).
  lukky: {
    AIML: "Lakshya_AiMl.pdf",
    SDE: "Lakshya_SDE.pdf",
  },
  // Rishi Raj: only SDE and AI/ML resumes are uploaded (WebD, DevOps, Data fall back to his SDE resume).
  rishii: {
    AIML: "Rishi_Raj_AIML.pdf",
    SDE: "Rishi_Raj_SDE.pdf",
  },
};

const norm = (role: string) => role.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The resume kind for a target role (the Role to Apply, or an approved research category). Anything not clearly a specialised
 * role (including custom "Other" roles) is SDE, which is also the universal fallback.
 */
export function resumeKindForRole(role: string): ResumeKind {
  const r = norm(role);
  if (/devops|site reliability|\bsre\b|cloud engineer|platform engineer/.test(r)) return "DevOps";
  if (/data (engineer|scientist|analyst)|analytics|business intelligence/.test(r)) return "Data";
  if (/front[ -]?end|full[ -]?stack|web (developer|designer|engineer)|website|\bmern\b|\bmean\b|\bui\b developer/.test(r)) return "WebD";
  if (/\bai\b|\bml\b|artificial intelligence|machine learning|\bllm\b|deep learning|computer vision|\bnlp\b|ai\/ml|agentic/.test(r)) return "AIML";
  return "SDE";
}

export interface ResumeUpload {
  fileName: string;
  mimeType: string;
}

export type ResumeDecision =
  | { status: "use"; kind: ResumeKind; fileName: string; fallbackFrom?: ResumeKind; reason?: string }
  | { status: "none"; kind: ResumeKind; reason: string };

/**
 * Chooses the file to attach from the member's OWN uploads. Pure: no I/O, so the rules are fully testable.
 * `uploads` must be that member's uploads only (duplicates preserved, so an ambiguous name is detected).
 */
export function planResume(memberId: MemberId, role: string, uploads: readonly ResumeUpload[]): ResumeDecision {
  const kind = resumeKindForRole(role);
  const files = MEMBER_RESUME_FILES[memberId] ?? {};
  const matches = (name: string | undefined) => (name ? uploads.filter((u) => u.fileName.toLowerCase() === name.toLowerCase()) : []);
  /** unique PDF upload with that name? */
  const check = (k: ResumeKind): { ok: true; fileName: string } | { ok: false; why: string } => {
    const name = files[k];
    if (!name) return { ok: false, why: `no ${k} resume is mapped for this member` };
    const found = matches(name);
    if (found.length === 0) return { ok: false, why: `${name} is not among the member's uploads` };
    if (found.length > 1) return { ok: false, why: `several uploads are named ${name} (ambiguous)` };
    if (found[0].mimeType !== "application/pdf") return { ok: false, why: `${name} is not a PDF` };
    return { ok: true, fileName: found[0].fileName };
  };
  const wanted = check(kind);
  if (wanted.ok) return { status: "use", kind, fileName: wanted.fileName };
  if (kind === "SDE") return { status: "none", kind, reason: wanted.why };
  const sde = check("SDE");
  if (sde.ok) return { status: "use", kind: "SDE", fileName: sde.fileName, fallbackFrom: kind, reason: `${kind} resume unavailable (${wanted.why}); the member's SDE resume was used` };
  return { status: "none", kind, reason: `${wanted.why}; SDE fallback also unavailable (${sde.why})` };
}
