import { MEMBER_IDS, type MemberId } from "@/config/members";
import { DAILY_IMPORT_LIMIT, DEFAULT_IMPORT_PER_RUN, MASTER_TAB } from "./types";
import { DEFAULT_BATCH_SIZE, DEFAULT_DAY_START, type ImportScheduleConfig } from "./import-schedule";

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
  /**
   * SEND-FIRST MODE. While this many (or more) real, eligible JobSync drafts are saved in the members' Gmail, a cycle does NOTHING but send: no manual-
   * Connection registration, no adoption of old drafts, no import, no drafting. 0 = off. Default 50. (The separate 100-draft rule that pauses drafting is unchanged.)
   */
  sendFirstAt: number;
  /**
   * SEND EVERY JOBSYNC DRAFT (OUTREACH_SEND_ALL_DRAFTS=true, default OFF). The owner's explicit instruction: every draft JobSync created that carries the member's OWN resume is sent,
   * whether or not it passes the content checks (word limit, company/role wording, "company research unavailable", review/parked flags, a stale resume version). Send-first
   * mode then stays on until no such draft is left (threshold 1). NEVER relaxed: the draft must still be a DRAFT in Gmail, the To address must be the contact, it must not mention
   * another member, the attachment must be this member's own resume (never another member's), and opt-outs, exclusions, invalid addresses and duplicate protection all still apply.
   */
  sendAllDrafts: boolean;
  /**
   * The import schedule (see import-schedule.ts): no imports before OUTREACH_IMPORTS_FROM (ISO), each day's allowance opens at OUTREACH_IMPORT_DAY_START
   * (local "HH:MM", default 00:15), in batches of OUTREACH_IMPORT_BATCH (default 50) that are drafted and sent before the next one is imported.
   */
  importSchedule?: ImportScheduleConfig;
  /** Runtime only (never read from the environment): the runner has switched send-first mode off for the rest of its run because it stopped making progress. */
  sendFirstSuspended?: boolean;
}

export const DEFAULT_SEND_FIRST_AT = 50;

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
    masterTab: /^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$/.test((env.OUTREACH_MASTER_TAB ?? "").trim()) ? (env.OUTREACH_MASTER_TAB ?? "").trim() : MASTER_TAB,
    ownerOverride: (MEMBER_IDS as readonly string[]).includes((env.OUTREACH_OWNER ?? "").trim()) ? ((env.OUTREACH_OWNER ?? "").trim() as MemberId) : null,
    sendAllowlist: (env.OUTREACH_SEND_ONLY_TO ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(s)),
    manualSince: Number.isNaN(Date.parse(env.OUTREACH_MANUAL_SINCE ?? "")) ? "" : new Date(Date.parse(env.OUTREACH_MANUAL_SINCE ?? "")).toISOString(),
    sendAllDrafts: env.OUTREACH_SEND_ALL_DRAFTS === "true",
    importSchedule: {
      importsFrom: Number.isNaN(Date.parse(env.OUTREACH_IMPORTS_FROM ?? "")) ? "" : new Date(Date.parse(env.OUTREACH_IMPORTS_FROM ?? "")).toISOString(),
      dayStart: /^([01]?\d|2[0-3]):[0-5]\d$/.test((env.OUTREACH_IMPORT_DAY_START ?? "").trim()) ? env.OUTREACH_IMPORT_DAY_START!.trim() : DEFAULT_DAY_START,
      batchSize: int(env.OUTREACH_IMPORT_BATCH, DEFAULT_BATCH_SIZE, 1, DAILY_IMPORT_LIMIT),
      dailyLimit: int(env.OUTREACH_DAILY_LIMIT, DAILY_IMPORT_LIMIT, 1, DAILY_IMPORT_LIMIT),
    },
    sendFirstAt: env.OUTREACH_SEND_FIRST_AT === undefined || env.OUTREACH_SEND_FIRST_AT.trim() === "" ? DEFAULT_SEND_FIRST_AT : int(env.OUTREACH_SEND_FIRST_AT.trim(), DEFAULT_SEND_FIRST_AT, 0, 1000),
  };
}
