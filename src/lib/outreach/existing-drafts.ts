/**
 * Brings EVERY unsent JobSync-created draft into the send workflow, however old it is.
 *
 * The send step works from the tracking tab: a draft whose Connection has no tracking row is invisible to it, however long it has been waiting.
 * That is the case for drafts the Network Finder wrote for its own Connections, and for manual Connections older than the 30-day window. This
 * step finds every Connection that still has an unsent ("created") draft in the draft ledger and has no tracking row yet, and registers it
 * (source "existing-draft"). From then on the normal send step decides each member's draft on its merits: send it (all safety checks passed,
 * correct member and resume), or leave it untouched in Gmail and record why (see send-workflow.ts).
 *
 * Nothing is sent, drafted, deleted or edited here: it only adds tracking rows. Idempotent: a Connection already tracked (by Connection, by
 * contact id) is never registered twice. A duplicate recipient (the same address on another Connection) IS registered, with its own contact id,
 * so its drafts get a recorded outcome ("already sent to this recipient") instead of waiting silently for ever.
 */
import { contactIdFor } from "@/lib/hr-master/ids";
import { normalizeEmail } from "@/lib/hr-master/normalize";
import { MEMBER_IDS } from "@/config/members";
import { nowIso } from "@/lib/utils/time";
import type { Connection } from "@/types/domain";
import type { OutreachSheet } from "./sheet";
import { FALLBACK_SALUTATION } from "./contacts";
import { isParkedDetail } from "@/lib/gmail/draft-flags";
import { draftKeyFor, type LedgerEntry } from "./sync";
import { emptyDrafts, emptySendFields, type Segment, type TrackingRecord } from "./types";

/** Bookkeeping bound per cron call (each registration is a Sheets write). It does NOT limit sending: the rest is registered on the next call. */
export const ADOPT_PER_RUN = 40;

export interface AdoptDeps {
  sheet: Pick<OutreachSheet, "readTracking" | "appendTracking">;
  connections: { listFresh(): Promise<Connection[]> };
  /** The whole draft ledger (NF_Drafts), keyed `contact:<connectionId>:<member>`. */
  ledger(): Promise<ReadonlyMap<string, LedgerEntry>>;
  now: () => Date;
  /** Epoch ms after which no new registration is started. */
  deadline?: number;
  perRun?: number;
  /** Records on a draft-ledger row why it cannot be sent (the Gmail draft itself is never touched). Absent = orphans are only reported. */
  park?: (draftKey: string, reason: string) => Promise<void>;
}

export interface AdoptResult {
  /** Connections registered in this call. */
  adopted: number;
  /** Connections with unsent drafts still waiting to be registered (next call). */
  remaining: number;
  /** Unsent drafts whose Connection no longer exists: left untouched in Gmail, cannot be sent; they are recorded as such (see `parked`). */
  orphaned: number;
  /** Orphaned drafts newly recorded as "cannot be sent" in this call, so they leave the eligible backlog (they stay in Gmail, untouched). */
  parked: number;
}

/** Connection ids that still have at least one unsent JobSync draft (a "created" row with its Gmail draft id). */
export function connectionsWithUnsentDrafts(ledger: ReadonlyMap<string, LedgerEntry>): Set<string> {
  const ids = new Set<string>();
  for (const [key, e] of ledger) {
    const m = /^contact:(.+):([a-z]+)$/.exec(key);
    if (!m || !(MEMBER_IDS as readonly string[]).includes(m[2])) continue;
    if (e.status === "created" && e.gmailDraftId) ids.add(m[1]);
  }
  return ids;
}

export async function adoptExistingDrafts(deps: AdoptDeps): Promise<AdoptResult> {
  const out: AdoptResult = { adopted: 0, remaining: 0, orphaned: 0, parked: 0 };
  const ledger = await deps.ledger();
  const wanted = connectionsWithUnsentDrafts(ledger);
  if (wanted.size === 0) return out;
  const { records, nextRow } = await deps.sheet.readTracking();
  const byConn = new Set(records.map((r) => r.connectionId).filter(Boolean));
  const byId = new Set(records.map((r) => r.contactId));
  const todo = [...wanted].filter((id) => !byConn.has(id));
  if (todo.length === 0) return out;

  const conns = new Map((await deps.connections.listFresh()).map((c) => [c.connectionId, c]));
  const live = todo.filter((id) => conns.has(id));
  out.orphaned = todo.length - live.length;
  const limit = deps.perRun ?? ADOPT_PER_RUN;
  const timeLeft = () => deps.deadline === undefined || Date.now() <= deps.deadline;
  if (deps.park) {
    for (const id of todo.filter((x) => !conns.has(x))) {
      for (const m of MEMBER_IDS) {
        const key = draftKeyFor(id, m);
        const e = ledger.get(key);
        if (!e || e.status !== "created" || !e.gmailDraftId || isParkedDetail(e.detail)) continue;
        if (out.parked >= limit || !timeLeft()) break;
        await deps.park(key, "the Connection no longer exists");
        out.parked += 1;
      }
    }
  }
  // Oldest Connection first, so the longest-waiting drafts are looked at first.
  live.sort((a, b) => conns.get(a)!.createdAt.localeCompare(conns.get(b)!.createdAt));

  const at = deps.now();
  const stamp = nowIso(at);
  let row = nextRow;
  for (const id of live) {
    if (out.adopted >= limit || (deps.deadline !== undefined && Date.now() > deps.deadline)) {
      out.remaining = live.length - out.adopted;
      break;
    }
    const c = conns.get(id)!;
    const e = normalizeEmail(c.email ?? "");
    const natural = e.valid ? contactIdFor(e.email) : "";
    // The recipient's own contact id unless another row already has it (a duplicate recipient): then the Connection id keeps the row unique.
    const contactId = natural && !byId.has(natural) ? natural : `draft-${id}`;
    const named = Boolean(c.name.trim()) && c.name.trim() !== FALLBACK_SALUTATION;
    const segment: Segment = named && c.company ? "person-and-company" : c.company ? "company-only" : named ? "person-only" : "neither";
    const rec: TrackingRecord = {
      row: 0, contactId, email: e.valid ? e.email : (c.email ?? "").trim(), source: "existing-draft", importStatus: "added", connectionId: id, ownerMemberId: c.memberId, importDay: "",
      claimedAt: stamp, addedAt: c.createdAt, attempts: 0, segment, targetRole: c.applyRole ?? "", roleBasis: "existing JobSync draft",
      processing: "drafted", drafts: emptyDrafts(), reviewReason: "", ...emptySendFields(), sentAt: "", lastError: "", updatedAt: stamp,
    };
    await deps.sheet.appendTracking(rec, row);
    row += 1;
    byConn.add(id);
    byId.add(contactId);
    out.adopted += 1;
  }
  return out;
}
