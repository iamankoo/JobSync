import { MEMBER_IDS, type MemberId } from "@/config/members";
import { resolveTimezone } from "@/lib/utils/time";
import { BATCH_SIZE } from "./scheduler";
import { PEOPLE_PER_COMPANY } from "./contacts";

/**
 * Network Finder settings (server-only environment variables; no secrets here — Apollo keys are read by
 * apollo-pool.ts). Everything is OFF unless NETWORK_FINDER_ENABLED=true.
 */
export interface NetworkFinderConfig {
  enabled: boolean;
  /** Member recorded as "Added by" on discovered Connections. */
  contactOwner: MemberId;
  /** Member recorded as "Added by" on discovered Jobs (agreed: Anni). */
  jobOwner: MemberId;
  timeZone: string;
  batchSize: number;
  peoplePerCompany: number;
  /** Most companies processed in one scheduler call (keeps each call well inside the function time limit). */
  maxCompaniesPerTick: number;
  /** How often a processed company is re-checked for new openings. */
  jobRecheckIntervalMs: number;
  dailyInternships: number;
  dailyFullTime: number;
  /** When Connections holds this many entries, new Network Finder contacts stop and all three members are told (no export, no deletion). */
  contactLimit: number;
  /** Each member's own profile text for their drafts (facts the drafts may use). Empty = drafts say nothing specific about them. */
  profiles: Partial<Record<MemberId, string>>;
  /** Each member's own email signature, appended unchanged under their drafts. Empty = the draft is signed with their name only. */
  signatures: Partial<Record<MemberId, string>>;
}

const perMember = (env: NodeJS.ProcessEnv, prefix: string, max: number) =>
  Object.fromEntries(
    MEMBER_IDS.map((m) => [m, (env[`${prefix}${m.toUpperCase()}`] ?? "").replace(/\\n/g, "\n").trim().slice(0, max)]).filter(([, v]) => v),
  ) as Partial<Record<MemberId, string>>;

const member = (raw: string | undefined, fallback: MemberId): MemberId =>
  (MEMBER_IDS as readonly string[]).includes(raw?.trim() ?? "") ? (raw!.trim() as MemberId) : fallback;

const posInt = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return raw !== undefined && Number.isInteger(n) && n > 0 ? n : fallback;
};

export function loadNetworkFinderConfig(env: NodeJS.ProcessEnv = process.env): NetworkFinderConfig {
  return {
    enabled: env.NETWORK_FINDER_ENABLED === "true",
    contactOwner: member(env.NETWORK_FINDER_CONTACT_OWNER, "anni"),
    jobOwner: member(env.NETWORK_FINDER_JOB_OWNER, "anni"),
    timeZone: resolveTimezone(env.APP_TIMEZONE),
    batchSize: posInt(env.NETWORK_FINDER_BATCH_SIZE, BATCH_SIZE),
    peoplePerCompany: posInt(env.NETWORK_FINDER_PEOPLE_PER_COMPANY, PEOPLE_PER_COMPANY),
    // One company per call keeps each call well inside a 60 s function limit (pages are read 1/s per site).
    maxCompaniesPerTick: posInt(env.NETWORK_FINDER_MAX_COMPANIES_PER_TICK, 1),
    jobRecheckIntervalMs: posInt(env.NETWORK_FINDER_JOB_RECHECK_HOURS, 24) * 3_600_000,
    dailyInternships: posInt(env.NETWORK_FINDER_DAILY_INTERNSHIPS, 15),
    dailyFullTime: posInt(env.NETWORK_FINDER_DAILY_FULL_TIME, 15),
    contactLimit: posInt(env.NETWORK_FINDER_CONTACT_LIMIT, 1000),
    profiles: perMember(env, "NETWORK_FINDER_PROFILE_", 1500),
    signatures: perMember(env, "NETWORK_FINDER_SIGNATURE_", 500),
  };
}
