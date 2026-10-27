import "server-only";
import { MEMBER_IDS, type MemberId } from "@/config/members";
import { SheetsError } from "@/lib/google-sheets/errors";
import { readDraftLedger } from "./store";

export interface EmailsSentStats {
  total: number;
  byMember: Record<MemberId, number>;
}

/**
 * Emails a member actually SENT from a JobSync draft. A ledger row becomes "sent" only after the sent-draft
 * tracker saw the draft gone AND a SENT message in its Gmail thread (gmail.metadata, GMAIL_TRACK_SENT).
 * Drafts still waiting, deleted drafts and anything merely generated are never counted.
 * Null while the NF_Drafts tab does not exist.
 */
export async function emailsSentStats(): Promise<EmailsSentStats | null> {
  try {
    const byMember = Object.fromEntries(MEMBER_IDS.map((m) => [m, 0])) as Record<MemberId, number>;
    for (const d of (await readDraftLedger()).values()) if (d.status === "sent") byMember[d.memberId] += 1;
    return { total: Object.values(byMember).reduce((a, b) => a + b, 0), byMember };
  } catch (err) {
    if (err instanceof SheetsError && err.code === "schema_invalid") return null;
    throw err;
  }
}
