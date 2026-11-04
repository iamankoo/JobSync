/**
 * Import of Outreach Database contacts into the existing (shared) Connections, ONE AT A TIME, with a write-ahead claim. The limit is
 * GLOBAL (all members together) over a ROLLING 24 hours, never a calendar day. Each Connection is one shared record; the per-member
 * e-mails are created by the drafting worker, not here.
 *
 * For each contact: (1) a tracking row "importing" is written and read back; (2) Connections is re-read and, only if the
 * e-mail is still absent, the Connection is created through the existing service; (3) the tracking row becomes "added" with
 * the new ConnectionID. A contact counts as added ONLY at step 3, after the Connection was saved. If the process dies between
 * 2 and 3, the next run finds the Connection by its normalised e-mail and just completes the tracking row (no second
 * Connection). Master Contacts rows are never modified or deleted.
 */
import { MEMBER_IDS, type MemberId } from "@/config/members";
import { normalizeEmail } from "@/lib/hr-master/normalize";
import { normalizeCompanyUrl } from "@/lib/utils/url";
import { dateInTimezone, nowIso } from "@/lib/utils/time";
import type { CreateConnectionInput } from "@/lib/validation/connections";
import type { Connection } from "@/types/domain";
import { FALLBACK_SALUTATION, firstInDuplicateGroups, importEligibility, importOrder, parseMasterRows, roleMapping, segmentOf } from "./contacts";
import type { OutreachSheet } from "./sheet";
import { MAX_IMPORT_ATTEMPTS, emptyDrafts, emptySendFields, type OutreachContact, type TrackingRecord } from "./types";

export interface ConnectionsPort {
  /** Current Connections, read fresh (not from the short read cache). */
  listFresh(): Promise<Connection[]>;
  /** The existing createConnection service (same validation, quiet: no per-contact push). */
  create(owner: MemberId, input: CreateConnectionInput): Promise<Connection>;
}

export interface ImportDeps {
  sheet: Pick<OutreachSheet, "readMaster" | "readTracking" | "appendTracking" | "updateTracking">;
  connections: ConnectionsPort;
  now: () => Date;
  timezone: string;
  dailyLimit: number;
  perRun: number;
  /** Epoch ms after which no new contact is started (the function time limit). */
  deadline?: number;
  members?: readonly MemberId[];
  /** Every imported Connection is owned by this member instead of round-robin (e.g. a controlled test sent from one Gmail account). */
  ownerOverride?: MemberId | null;
  /** An unfinished claim is only taken over by another call once it has not been touched for this long (a worker is still on it before). Default 0. */
  staleClaimMs?: number;
}

export interface ImportResult {
  day: string;
  importedThisRun: number;
  importedToday: number;
  dailyLimit: number;
  /** Interrupted claims that were completed or retried. */
  resumed: number;
  linkedExisting: number;
  failed: number;
  stoppedBecause: "daily-limit" | "run-limit" | "no-more-eligible" | "deadline" | "error" | "none";
  masterRejected: number;
  queueRemaining: number;
  errors: string[];
}

/** The Connection created for an Outreach Database contact. Never writes fallback wording into the company field. */
export function connectionInputFor(c: OutreachContact): CreateConnectionInput {
  const map = roleMapping(c.primaryRoleCategory);
  const url = c.companyUrl ? normalizeCompanyUrl(c.companyUrl) : null;
  const basis = c.roleBasis
    ? `Role basis: ${c.roleBasis} (${c.roleVerificationStatus || "n/a"}) - a targeting choice for outreach, not a verified opening.`
    : "Role basis: not recorded.";
  const lines = [
    `Source: Outreach Database ${c.contactId}`,
    `Contact: ${segmentOf(c)}${c.personName.trim() ? "" : ` (no person name; greeting uses "${FALLBACK_SALUTATION}")`}`,
    basis,
    ...(c.companyDescription ? [`Company description (from the company's website): ${c.companyDescription.replace(/\s+/g, " ").slice(0, 400)}`] : []),
  ];
  return {
    // Connections requires a name: a nameless contact is stored as "Hiring Team" HERE ONLY; the Outreach Database keeps PersonName empty.
    name: (c.personName.trim() || FALLBACK_SALUTATION).slice(0, 120),
    ...(c.companyName.trim() ? { company: c.companyName.trim().slice(0, 120) } : {}),
    ...(c.personDesignation.trim() ? { role: c.personDesignation.trim().slice(0, 120) } : {}),
    email: c.personEmail,
    ...(url ? { companyUrl: url } : {}),
    roleCategory: map.roleCategory,
    applyRole: map.applyRole,
    notes: lines.join("\n").slice(0, 2000),
    status: "Not Connected",
  } as CreateConnectionInput;
}

const emailKey = (e: string | undefined) => (e ? normalizeEmail(e).email : "");

export function indexConnectionsByEmail(list: readonly Connection[]): Map<string, Connection> {
  const m = new Map<string, Connection>();
  for (const c of [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const k = emailKey(c.email);
    if (k && !m.has(k)) m.set(k, c);
  }
  return m;
}

/** Persists a change FIRST and updates the in-memory record only if the write succeeded (a failed write never leaves a false "added"). */
async function commit(sheet: Pick<OutreachSheet, "updateTracking">, rec: TrackingRecord, patch: Partial<TrackingRecord>): Promise<void> {
  await sheet.updateTracking({ ...rec, ...patch });
  Object.assign(rec, patch);
}

const errName = (e: unknown) => (e instanceof Error ? (e.name === "Error" ? e.message : e.name) : "error").slice(0, 120);

export async function runOutreachImport(deps: ImportDeps): Promise<ImportResult> {
  const at = deps.now();
  const day = dateInTimezone(at, deps.timezone);
  const stamp = nowIso(at);
  const members = deps.members ?? MEMBER_IDS;
  const res: ImportResult = { day, importedThisRun: 0, importedToday: 0, dailyLimit: deps.dailyLimit, resumed: 0, linkedExisting: 0, failed: 0, stoppedBecause: "none", masterRejected: 0, queueRemaining: 0, errors: [] };

  const parsed = parseMasterRows(await deps.sheet.readMaster());
  res.masterRejected = parsed.rejected.length;
  const byId = new Map(parsed.contacts.map((c) => [c.contactId, c]));
  const tracking = await deps.sheet.readTracking();
  let nextRow = tracking.nextRow;
  const records = tracking.records;
  const connByEmail = indexConnectionsByEmail(await deps.connections.listFresh());

  // 1. Finish interrupted claims.
  const retry: TrackingRecord[] = [];
  for (const r of records.filter((x) => x.importStatus === "importing")) {
    const existing = connByEmail.get(emailKey(r.email));
    if (existing) {
      await commit(deps.sheet, r, { importStatus: "added", connectionId: existing.connectionId, ownerMemberId: existing.memberId, addedAt: r.addedAt || stamp, updatedAt: stamp });
      res.resumed += 1;
    } else if (r.attempts >= MAX_IMPORT_ATTEMPTS) {
      await commit(deps.sheet, r, { importStatus: "import_failed", updatedAt: stamp });
      res.failed += 1;
    } else if (r.source === "outreach-database" && at.getTime() - Date.parse(r.updatedAt || r.claimedAt) >= (deps.staleClaimMs ?? 0)) retry.push(r);
  }

  // Rolling 24 hours from the FIRST claim of each contact (a retry never moves it). Contacts linked to an already existing Connection do not count.
  const windowStart = at.getTime() - 24 * 60 * 60_000;
  const inWindow = (rows: readonly TrackingRecord[]) => rows.filter((r) => r.source === "outreach-database" && Date.parse(r.claimedAt) > windowStart && (r.importStatus === "added" || r.importStatus === "importing") && r.lastError !== "linked-existing");
  const countedToday = () => inWindow(records).length;
  const quota = () => Math.max(0, deps.dailyLimit - countedToday());

  // 2. The queue: eligible, untracked, not already in Connections (manual or earlier), best-identified first.
  const trackedIds = new Set(records.map((r) => r.contactId));
  const trackedEmails = new Set(records.map((r) => emailKey(r.email)));
  const firstInGroup = firstInDuplicateGroups(parsed.contacts);
  const queue = parsed.contacts
    .filter((c) => !trackedIds.has(c.contactId) && !trackedEmails.has(c.personEmail) && !connByEmail.has(c.personEmail) && importEligibility(c, firstInGroup).eligible)
    .sort(importOrder);
  res.queueRemaining = queue.length;

  const work: { contact: OutreachContact; rec?: TrackingRecord }[] = [
    ...retry.flatMap((r) => (byId.has(r.contactId) ? [{ contact: byId.get(r.contactId)!, rec: r }] : [])),
    ...queue.map((contact) => ({ contact })),
  ];

  let started = 0;
  for (const item of work) {
    if (quota() <= 0) { res.stoppedBecause = "daily-limit"; break; }
    if (started >= deps.perRun) { res.stoppedBecause = "run-limit"; break; }
    if (deps.deadline !== undefined && Date.now() > deps.deadline) { res.stoppedBecause = "deadline"; break; }
    started += 1;
    const { contact } = item;
    let rec = item.rec;
    try {
      if (!rec) {
        const owner = deps.ownerOverride ?? members[records.filter((r) => r.source === "outreach-database").length % members.length];
        rec = await deps.sheet.appendTracking(
          {
            row: 0, contactId: contact.contactId, email: contact.personEmail, source: "outreach-database", importStatus: "importing", connectionId: "", ownerMemberId: owner, importDay: day,
            claimedAt: stamp, addedAt: "", attempts: 1, segment: segmentOf(contact), targetRole: roleMapping(contact.primaryRoleCategory).applyRole, roleBasis: contact.roleBasis,
            processing: "awaiting", drafts: emptyDrafts(), reviewReason: "", ...emptySendFields(), sentAt: "", lastError: "", updatedAt: stamp,
          },
          nextRow,
        );
        nextRow += 1;
        records.push(rec);
        trackedIds.add(rec.contactId);
      } else {
        await commit(deps.sheet, rec, { attempts: rec.attempts + 1, importDay: day, updatedAt: stamp });
        res.resumed += 1;
      }
      // Re-check Connections right before creating: a member may have added this person a moment ago.
      const fresh = indexConnectionsByEmail(await deps.connections.listFresh());
      const there = fresh.get(contact.personEmail);
      if (there) {
        await commit(deps.sheet, rec, { importStatus: "added", connectionId: there.connectionId, ownerMemberId: there.memberId, addedAt: stamp, lastError: "linked-existing", updatedAt: stamp });
        res.linkedExisting += 1;
        continue;
      }
      // Concurrency guard (new AND resumed claims), decided from ONE fresh read of the tracking tab:
      //  1. the FIRST live claim for a contact (sheet order) is the only one allowed to create its Connection; later duplicates stand down;
      //  2. a claim may create a Connection only if its place among the live claims of the last 24 hours, in sheet order, is within the limit.
      // Both rules are deterministic, so overlapping workers can never create a duplicate Connection or exceed the limit together.
      {
        const live = inWindow((await deps.sheet.readTracking()).records).sort((a, b) => a.row - b.row);
        const firstPerContact = live.filter((r, i) => live.findIndex((x) => x.contactId === r.contactId) === i);
        const mine = rec;
        if (!firstPerContact.some((r) => r.row === mine.row)) {
          if (live.some((r) => r.contactId === mine.contactId && r.row < mine.row)) await commit(deps.sheet, mine, { importStatus: "import_failed", lastError: "duplicate-claim", updatedAt: stamp });
          continue; // another worker owns this contact
        }
        const rank = firstPerContact.findIndex((r) => r.row === mine.row) + 1;
        if (rank > deps.dailyLimit) {
          await commit(deps.sheet, mine, { importStatus: "import_failed", lastError: "over-limit", updatedAt: stamp });
          res.stoppedBecause = "daily-limit";
          break;
        }
      }
      const created = await deps.connections.create(rec.ownerMemberId as MemberId, connectionInputFor(contact));
      // Only now is the contact "added": the Connection exists.
      // The Connection exists. If this write fails the record stays "importing" and the next call links it by e-mail.
      connByEmail.set(contact.personEmail, created);
      await commit(deps.sheet, rec, { importStatus: "added", connectionId: created.connectionId, addedAt: nowIso(deps.now()), lastError: "", updatedAt: nowIso(deps.now()) });
      connByEmail.set(contact.personEmail, created);
      res.importedThisRun += 1;
    } catch (err) {
      res.errors.push(errName(err));
      if (rec && rec.row >= 2) {
        // Never downgrade a record whose Connection was saved; only note the failure.
        const giveUp = rec.attempts >= MAX_IMPORT_ATTEMPTS && rec.importStatus === "importing" && !connByEmail.has(contact.personEmail);
        await commit(deps.sheet, rec, { lastError: errName(err), updatedAt: stamp, ...(giveUp ? { importStatus: "import_failed" as const } : {}) }).catch(() => undefined);
        if (giveUp) res.failed += 1;
      }
      res.stoppedBecause = "error"; // do not hammer a failing backend; the next call resumes this contact
      break;
    }
  }
  if (res.stoppedBecause === "none") res.stoppedBecause = work.length === 0 || started >= work.length ? "no-more-eligible" : "run-limit";
  res.importedToday = countedToday();
  res.queueRemaining = Math.max(0, queue.filter((c) => !trackedIds.has(c.contactId)).length);
  return res;
}
