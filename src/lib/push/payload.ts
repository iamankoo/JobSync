import { MEMBER_IDS, getMember, type MemberId } from "@/config/members";
import { ID_PATTERN } from "@/lib/validation/applications";

/** What the service worker receives. Contains only public, same-for-everyone job facts. */
export interface PushPayload {
  title: string;
  body: string;
  /** Same-origin path the notification opens. */
  url: string;
  /** Collapses duplicates on the device. */
  tag: string;
  /** Sender's public profile photo path. */
  icon?: string;
}

const CONTROL = /[\u0000-\u001F\u007F]/g;

export function clean(text: string, max: number): string {
  const t = text.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** The two members who must be told about `actor`'s action. Never includes the actor. */
export function recipientsFor(actor: MemberId): MemberId[] {
  return MEMBER_IDS.filter((m) => m !== actor);
}

/** Pages a notification may open. Everything else falls back to the dashboard. */
const SAFE_PATHS = new Set(["/dashboard", "/all-jobs", "/my-applications", "/add-job", "/group-chat", "/connections"]);

/** Same-origin, allow-listed destination for a job. The JobID must be a well-formed ID. */
export function jobUrl(jobId: string): string {
  return ID_PATTERN.test(jobId) ? `/all-jobs?job=${encodeURIComponent(jobId)}` : "/all-jobs";
}

/** Validates a click destination (mirrored in public/sw.js). */
export function safeUrl(raw: string, origin = "https://placeholder.invalid"): string {
  try {
    const u = new URL(raw, origin);
    if (u.origin !== new URL(origin).origin || !SAFE_PATHS.has(u.pathname)) return "/dashboard";
    return `${u.pathname}${u.search}`;
  } catch {
    return "/dashboard";
  }
}

interface JobFacts {
  jobId: string;
  company: string;
  jobRole: string;
}

export function jobAddedPayload(actor: MemberId, job: JobFacts): PushPayload {
  const m = getMember(actor);
  const name = m?.name ?? "A teammate";
  return {
    title: clean(`${name} added a job: ${job.jobRole}`, 110),
    body: clean(`${job.company} — tap to view the job.`, 140),
    url: jobUrl(job.jobId),
    tag: `job-added-${job.jobId}`,
    icon: m?.photo,
  };
}

export function jobAppliedPayload(actor: MemberId, job: JobFacts): PushPayload {
  const m = getMember(actor);
  const name = m?.name ?? "A teammate";
  return {
    title: clean(`${name} applied for ${job.jobRole} — hurry up!`, 110),
    body: clean(`${job.company} — open JobSync to apply too.`, 140),
    url: jobUrl(job.jobId),
    tag: `job-applied-${job.jobId}-${actor}`,
    icon: m?.photo,
  };
}

interface ConnectionFacts {
  connectionId: string;
  name: string;
  company?: string;
  role?: string;
}

/** A new person (and their company) on the shared Connections list. Message and notes are never included. */
export function connectionAddedPayload(actor: MemberId, c: ConnectionFacts): PushPayload {
  const m = getMember(actor);
  const name = m?.name ?? "A teammate";
  const where = [c.role, c.company].filter(Boolean).join(" · ");
  return {
    title: clean(`${name} added a connection: ${c.name}`, 110),
    body: clean(`${where ? `${where} — ` : ""}tap to view in Connections.`, 140),
    url: "/connections",
    tag: `connection-added-${c.connectionId}`,
    icon: m?.photo,
  };
}

export interface ChatFacts {
  messageId: string;
  kind: "text" | "file" | "voice";
  text?: string;
  fileName?: string;
}

/** Prefix of every Group Chat message notification tag (the service worker recognises it). */
export const CHAT_TAG_PREFIX = "chat-";

/**
 * A new Group Chat message. One tag per sender, so a burst of messages from the same person replaces
 * the previous notification instead of piling up (the service worker re-alerts for each one).
 */
export function chatMessagePayload(actor: MemberId, msg: ChatFacts): PushPayload {
  const m = getMember(actor);
  const name = m?.name ?? "A teammate";
  const preview =
    msg.kind === "voice" ? "🎤 Voice note" : msg.kind === "file" ? `📎 ${msg.text ? msg.text : msg.fileName ? msg.fileName : "Attachment"}` : msg.text ?? "";
  return {
    title: clean(`New Group Chat message from ${name}`, 110),
    body: clean(preview, 140) || "Open Group Chat to read it.",
    url: "/group-chat",
    tag: `${CHAT_TAG_PREFIX}${actor}`,
    icon: m?.photo,
  };
}

export function callStartedPayload(actor: MemberId, callId: string, media: "audio" | "video"): PushPayload {
  const m = getMember(actor);
  const name = m?.name ?? "A teammate";
  return {
    title: clean(`${name} started a ${media} call`, 110),
    body: "Open Group Chat to join.",
    url: "/group-chat",
    tag: `call-${callId}`,
    icon: m?.photo,
  };
}
