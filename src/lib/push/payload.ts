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
const SAFE_PATHS = new Set(["/dashboard", "/all-jobs", "/my-applications", "/add-job"]);

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
