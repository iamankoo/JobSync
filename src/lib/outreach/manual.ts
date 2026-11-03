/**
 * Manually added Connections (Aniket, Lakshya or Rishi) enter the SAME pipeline as imported contacts: they get a tracking row
 * (source "manual") and are drafted by the same worker (runPendingDrafts, which already handles any Not Connected connection
 * with an e-mail). A contact is identified by its normalised e-mail, so a manual add and an automatic import of the same person
 * can never both be processed: whichever got there first owns the tracking row, and the other is skipped.
 */
import { contactIdFor } from "@/lib/hr-master/ids";
import { normalizeEmail } from "@/lib/hr-master/normalize";
import { MANUAL_WINDOW_DAYS } from "./config";
import { FALLBACK_SALUTATION } from "./contacts";
import type { OutreachSheet } from "./sheet";
import { emptyDrafts, emptySendFields, type Segment, type TrackingRecord } from "./types";
import { nowIso } from "@/lib/utils/time";
import type { Connection } from "@/types/domain";

/** Connections created by the Network Finder discovery are drafted by its own flow; imports are tracked by the importer. */
const isOtherFlow = (c: Connection) => (c.notes ?? "").startsWith("Source: Network Finder");

export interface ManualDeps {
  sheet: Pick<OutreachSheet, "readTracking" | "appendTracking">;
  connections: { listFresh(): Promise<Connection[]> };
  now: () => Date;
  windowDays?: number;
}

export async function registerManualConnections(deps: ManualDeps): Promise<{ registered: number; alreadyTracked: number; skipped: number }> {
  const at = deps.now();
  const cutoff = new Date(at.getTime() - (deps.windowDays ?? MANUAL_WINDOW_DAYS) * 86_400_000).toISOString();
  const { records, nextRow } = await deps.sheet.readTracking();
  const byConn = new Set(records.map((r) => r.connectionId).filter(Boolean));
  const byEmail = new Set(records.map((r) => normalizeEmail(r.email).email));
  const byId = new Set(records.map((r) => r.contactId));
  let row = nextRow;
  const out = { registered: 0, alreadyTracked: 0, skipped: 0 };
  const list = (await deps.connections.listFresh()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const c of list) {
    if (isOtherFlow(c) || c.createdAt < cutoff) continue;
    const e = normalizeEmail(c.email ?? "");
    if (!e.valid) { out.skipped += 1; continue; }
    const id = contactIdFor(e.email);
    if (byConn.has(c.connectionId) || byEmail.has(e.email) || byId.has(id)) { out.alreadyTracked += 1; continue; }
    const named = Boolean(c.name.trim()) && c.name.trim() !== FALLBACK_SALUTATION;
    const segment: Segment = named && c.company ? "person-and-company" : c.company ? "company-only" : named ? "person-only" : "neither";
    const rec: TrackingRecord = {
      row: 0, contactId: id, email: e.email, source: "manual", importStatus: "added", connectionId: c.connectionId, ownerMemberId: c.memberId, importDay: "",
      claimedAt: nowIso(at), addedAt: c.createdAt, attempts: 0, segment, targetRole: c.applyRole ?? "", roleBasis: "chosen by member",
      processing: "awaiting", drafts: emptyDrafts(), reviewReason: "", ...emptySendFields(), sentAt: "", lastError: "", updatedAt: nowIso(at),
    };
    await deps.sheet.appendTracking(rec, row);
    row += 1;
    byConn.add(c.connectionId);
    byEmail.add(e.email);
    byId.add(id);
    out.registered += 1;
  }
  return out;
}
