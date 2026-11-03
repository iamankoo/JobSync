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
  /** `kind` = the resume kind used; `note` = why a fallback (that member's own SDE resume) was used, when it was. */
  | { status: "attached"; attachment: DraftAttachment; kind?: string; note?: string }
  /** This member does not attach resumes (kept for callers that opt a member out; nobody is opted out now). */
  | { status: "not_enabled" }
  /** Neither the specialised resume nor the member's own SDE fallback is usable: no attachment, the draft is flagged. */
  | { status: "unmapped"; reason?: string }
  /** The mapped file is not among the member's uploads. */
  | { status: "missing"; fileName: string }
  | { status: "unreadable"; reason: string };

export type ResumeLookup = (memberId: string, roleTitle: string) => Promise<ResumeResult>;

/** Header-safe file name: ASCII letters, digits, dot, dash, underscore, space. */
export const safeAttachmentName = (name: string) => name.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 100) || "resume.pdf";
