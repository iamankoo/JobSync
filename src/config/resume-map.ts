import type { MemberId } from "./members";

/**
 * Which uploaded resume goes on a manual connection's Gmail draft, by the SELECTED Role to Apply.
 *
 * Attachments are enabled ONLY for Aniket for now. A member that is not listed here gets exactly the drafts it got before
 * (no attachment). For a listed member, a role that is not in their table gets NO attachment (never a guess) and the draft
 * is flagged for review. File names are matched exactly (ignoring case) against that member's OWN uploaded PDFs in Profile.
 *
 * To assign another role or member later, add a line here; nothing else changes.
 */
export const RESUME_BY_ROLE: Partial<Record<MemberId, Readonly<Record<string, string>>>> = {
  anni: {
    "ai/ml engineer": "Aniket-Raj-AIML.pdf",
    "ai engineer": "Aniket-Raj-AIML.pdf",
    "applied ai engineer": "Aniket-Raj-AIML.pdf",
    "backend engineer": "Aniket_Raj_BE.pdf",
    "backend developer": "Aniket_Raj_BE.pdf",
    "software engineer": "Aniket_Raj_BE.pdf",
    "software developer": "Aniket_Raj_BE.pdf",
    "front end developer": "Aniket_Raj_WebD.pdf",
    "full stack engineer": "Aniket_Raj_WebD.pdf",
    "web developer": "Aniket_Raj_WebD.pdf",
    "data engineer": "Aniket_Raj_Data.pdf",
    // Deliberately NOT mapped yet (no guessed resume): Data Analyst, Data Scientist, Data Entry, Agentic AI Engineer,
    // Machine Learning Engineer, Python Developer, App Developer and any custom ("Other") role.
  },
};

const key = (role: string) => role.toLowerCase().replace(/\s+/g, " ").trim();

/** `enabled` = this member attaches resumes at all; `fileName` = the one mapped for this role (absent = unmapped). */
export function resumePlanFor(memberId: MemberId, roleTitle: string): { enabled: boolean; fileName?: string } {
  const table = RESUME_BY_ROLE[memberId];
  if (!table) return { enabled: false };
  const fileName = table[key(roleTitle)];
  return fileName ? { enabled: true, fileName } : { enabled: true };
}
