import "server-only";
import type { MemberId } from "@/config/members";
import { SheetsError } from "@/lib/google-sheets/errors";
import { readConnectionsLocated } from "@/lib/google-sheets/repositories";
import { readDraftLedger } from "./store";

export type DraftListStatus = "Drafted" | "Sent";

export interface DraftListItem {
  draftKey: string;
  company: string;
  person: string;
  designation: string;
  email: string;
  status: DraftListStatus;
  createdAt: string;
}

export interface DraftList {
  /** False while the NF_Drafts tab does not exist. */
  setUp: boolean;
  drafted: number;
  sent: number;
  items: DraftListItem[];
}

/**
 * The SIGNED-IN member's own Network Finder drafts, from the real draft ledger (NF_Drafts) joined with the
 * Connections entry each draft is about. "created" = still a draft in their Gmail; "sent" = the sent-draft tracker
 * saw it sent. Deleted, skipped and failed drafts are not listed. Newest first.
 */
export async function draftListFor(memberId: MemberId): Promise<DraftList> {
  let ledger: Awaited<ReturnType<typeof readDraftLedger>>;
  try {
    ledger = await readDraftLedger();
  } catch (err) {
    if (err instanceof SheetsError && err.code === "schema_invalid") return { setUp: false, drafted: 0, sent: 0, items: [] };
    throw err;
  }
  const mine = [...ledger.values()].filter((d) => d.memberId === memberId && d.itemType === "contact" && (d.status === "created" || d.status === "sent"));
  if (mine.length === 0) return { setUp: true, drafted: 0, sent: 0, items: [] };

  let byId = new Map<string, { company?: string; name: string; role?: string; email?: string }>();
  try {
    byId = new Map((await readConnectionsLocated()).items.map((i) => [i.value.connectionId, i.value]));
  } catch (err) {
    if (!(err instanceof SheetsError && err.code === "schema_invalid")) throw err;
  }
  const items: DraftListItem[] = mine
    .map((d) => {
      const c = byId.get(d.itemId);
      return {
        draftKey: d.draftKey,
        company: c?.company ?? "",
        person: c?.name ?? "",
        designation: c?.role ?? "",
        email: c?.email ?? "",
        status: d.status === "sent" ? ("Sent" as const) : ("Drafted" as const),
        createdAt: d.createdAt,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { setUp: true, drafted: items.filter((i) => i.status === "Drafted").length, sent: items.filter((i) => i.status === "Sent").length, items };
}
