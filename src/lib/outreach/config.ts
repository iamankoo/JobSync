import { loadSendLimits, type SendLimits } from "./limits";
import { DAILY_IMPORT_LIMIT, DEFAULT_IMPORT_PER_RUN } from "./types";

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
  };
}
