import { MEMBER_IDS, type MemberId } from "@/config/members";
import { loadSendLimits, type SendLimits } from "./limits";
import { DAILY_IMPORT_LIMIT, DEFAULT_IMPORT_PER_RUN, MASTER_TAB } from "./types";

/** Manual connections older than this are not picked up (same window as the drafting worker). */
export const MANUAL_WINDOW_DAYS = 30;

export interface OutreachConfig {
  /** The whole outreach cron step is OFF unless OUTREACH_ENABLED=true. */
  enabled: boolean;
  /** Spreadsheet id of the "Outreach Database" (a different file from the production JobSync Database). */
  spreadsheetId: string;
  dailyLimit: number;
  perRun: number;
  draftsPerRun: number;
  /** Sending limits (conservative defaults, hard ceilings). They only matter once the compile-time sending gate is opened. */
  sendLimits: SendLimits;
  /** The tab contacts are read from (default "Master Contacts"). A separate tab lets a controlled test run on its own contacts. */
  masterTab: string;
  /** When set, EVERY imported Connection is owned by this member (and so sent from that member's Gmail). Unset = round-robin. */
  ownerOverride: MemberId | null;
  /**
   * When non-empty, ONLY these recipients can ever be sent to (exact addresses, or a "*" wildcard in the local part, e.g.
   * "me+jobsync*@gmail.com"). A hard safety net for controlled tests; empty = no allowlist.
   */
  sendAllowlist: string[];
  /** ISO time: Connections members added by hand BEFORE this are ignored by the outreach pipeline (so existing ones are never auto-sent). */
  manualSince: string;
}

const int = (v: string | undefined, d: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : d;
};

/** Reads non-secret settings. The daily limit can be lowered but never raised above 200. */
export function loadOutreachConfig(env: NodeJS.ProcessEnv = process.env): OutreachConfig {
  return {
    enabled: env.OUTREACH_ENABLED === "true",
    spreadsheetId: (env.OUTREACH_SPREADSHEET_ID ?? "").trim(),
    dailyLimit: int(env.OUTREACH_DAILY_LIMIT, DAILY_IMPORT_LIMIT, 1, DAILY_IMPORT_LIMIT),
    perRun: int(env.OUTREACH_IMPORT_PER_RUN, DEFAULT_IMPORT_PER_RUN, 1, 50),
    draftsPerRun: int(env.OUTREACH_DRAFTS_PER_RUN, 2, 1, 10),
    sendLimits: loadSendLimits(env),
    masterTab: /^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$/.test((env.OUTREACH_MASTER_TAB ?? "").trim()) ? (env.OUTREACH_MASTER_TAB ?? "").trim() : MASTER_TAB,
    ownerOverride: (MEMBER_IDS as readonly string[]).includes((env.OUTREACH_OWNER ?? "").trim()) ? ((env.OUTREACH_OWNER ?? "").trim() as MemberId) : null,
    sendAllowlist: (env.OUTREACH_SEND_ONLY_TO ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(s)),
    manualSince: Number.isNaN(Date.parse(env.OUTREACH_MANUAL_SINCE ?? "")) ? "" : new Date(Date.parse(env.OUTREACH_MANUAL_SINCE ?? "")).toISOString(),
  };
}
