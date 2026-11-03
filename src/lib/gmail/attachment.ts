/** A file attached to a Gmail DRAFT (never sent). Pure types, safe to import anywhere. */
export interface DraftAttachment {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

/** Resumes are capped at 2 MB by the upload rules; this is a safety net, not the limit. */
export const MAX_ATTACHMENT_BYTES = 5_000_000;

/** What the resume step found for one member + role. */
export type ResumeResult =
  | { status: "attached"; attachment: DraftAttachment }
  /** This member does not attach resumes (unchanged behaviour). */
  | { status: "not_enabled" }
  /** The member attaches resumes but no file is mapped to this role: nothing is attached, the draft is flagged. */
  | { status: "unmapped" }
  /** The mapped file is not among the member's uploads. */
  | { status: "missing"; fileName: string }
  | { status: "unreadable"; reason: string };

export type ResumeLookup = (memberId: string, roleTitle: string) => Promise<ResumeResult>;

/** Header-safe file name: ASCII letters, digits, dot, dash, underscore, space. */
export const safeAttachmentName = (name: string) => name.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 100) || "resume.pdf";
