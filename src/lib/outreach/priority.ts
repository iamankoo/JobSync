/**
 * PRIORITY CONTACTS: contacts that must be imported BEFORE the rest of the Outreach Database backlog, without renumbering or rewriting anything.
 *
 * Mechanism: an optional tab "Priority Contacts" in the Outreach Database, with the SAME columns as Master Contacts. Its rows are the priority
 * queue, in sheet order (row 2 is first). A row is one of two kinds:
 *   - a full contact row (a contact that is not in Master Contacts yet), parsed with exactly the same rules as Master Contacts; or
 *   - an ID-only row (only ContactID filled in) that PROMOTES an existing Master Contacts row: the contact keeps its Master data and ContactID.
 * Everything else is unchanged: Master Contacts is never edited, ContactIDs are deterministic (derived from the e-mail), tracking rows, send
 * history and the de-duplication by ContactID / e-mail still apply, so a contact can never be imported twice, whichever tab it is listed in.
 * The importer takes the priority queue first and then the remaining Master queue; the send step treats priority contacts as eligible exactly like
 * Master ones. The tab does not exist until it is created deliberately; without it nothing changes. The 200-per-rolling-24-hours IMPORT limit is
 * unaffected: priority contacts are imported through the same importer, under the same limit.
 */
import { parseMasterRows } from "./contacts";
import type { OutreachContact } from "./types";

type Grid = readonly (readonly string[])[];

export interface PrioritySource {
  /** The priority contacts in queue order (promoted Master contacts included), de-duplicated. */
  contacts: OutreachContact[];
  /** Rows that were not usable, with the reason (never imported, never deleted). */
  rejected: { sheetRow: number; contactId: string; reason: string }[];
  /** ContactIDs that promote an existing Master Contacts row (no new data). */
  promotedIds: Set<string>;
}

const EMPTY: PrioritySource = { contacts: [], rejected: [], promotedIds: new Set() };
const memo = new WeakMap<object, { master: object; value: PrioritySource }>();

export function resolvePriorityContacts(priorityGrid: Grid, master: { contacts: readonly OutreachContact[] }): PrioritySource {
  if (!priorityGrid || priorityGrid.length < 2) return EMPTY;
  const hit = memo.get(priorityGrid);
  if (hit && hit.master === master) return hit.value;

  const header = (priorityGrid[0] ?? []).map((h) => h.trim());
  const idCol = header.indexOf("ContactID");
  const emailCol = header.indexOf("PersonEmail");
  const out: PrioritySource = { contacts: [], rejected: [], promotedIds: new Set() };
  if (idCol < 0 || emailCol < 0) {
    out.rejected.push({ sheetRow: 1, contactId: "", reason: "the Priority Contacts header lacks ContactID / PersonEmail" });
    memo.set(priorityGrid, { master, value: out });
    return out;
  }
  const masterById = new Map(master.contacts.map((c) => [c.contactId, c]));
  const seenIds = new Set<string>();
  const seenEmails = new Set<string>();
  for (let r = 1; r < priorityGrid.length; r++) {
    const row = priorityGrid[r];
    if (row.every((c) => !String(c ?? "").trim())) continue;
    const sheetRow = r + 1;
    const id = String(row[idCol] ?? "").trim();
    const email = String(row[emailCol] ?? "").trim();
    let contact: OutreachContact | undefined;
    let promoted = false;
    if (!email && id) {
      const m = masterById.get(id);
      if (!m) { out.rejected.push({ sheetRow, contactId: id, reason: "promoted ContactID is not in Master Contacts" }); continue; }
      contact = m;
      promoted = true;
    } else {
      const parsed = parseMasterRows([header, row as string[]]);
      if (!parsed.contacts.length) { out.rejected.push({ sheetRow, contactId: id, reason: parsed.rejected[0]?.reason ?? "unusable row" }); continue; }
      contact = { ...parsed.contacts[0], sheetRow };
    }
    if (seenIds.has(contact.contactId) || seenEmails.has(contact.personEmail)) { out.rejected.push({ sheetRow, contactId: contact.contactId, reason: "duplicate in the Priority Contacts list" }); continue; }
    seenIds.add(contact.contactId);
    seenEmails.add(contact.personEmail);
    if (promoted) out.promotedIds.add(contact.contactId);
    out.contacts.push(contact);
  }
  memo.set(priorityGrid, { master, value: out });
  return out;
}
