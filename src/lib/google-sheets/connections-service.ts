import "server-only";
import { isAdmin, type MemberId } from "@/config/members";
import { CONNECTION_STATUSES, type Connection, type ConnectionStatus } from "@/types/domain";
import { nowIso } from "@/lib/utils/time";
import { notifyConnectionAdded } from "@/lib/push/notify";
import { recordActivity } from "./activity-service";
import type { CreateConnectionInput, UpdateConnectionInput } from "@/lib/validation/connections";
import { DomainError, SheetsError } from "./errors";
import { newId } from "./ids";
import { withWriteLock } from "./lock";
import { appendConnection, deleteTabRows, readConnectionsLocated, updateConnectionRow } from "./repositories";

/** The SHARED connections list (everyone's entries, like Jobs), most recently touched first. */
export async function listConnections(): Promise<Connection[]> {
  const { items } = await readConnectionsLocated();
  return items.map((i) => i.value).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export interface ConnectionStats {
  total: number;
  byStatus: Record<ConnectionStatus, number>;
}

/** Counts of the shared list for the Dashboard card; null while the optional Connections tab does not exist. */
export async function connectionStats(): Promise<ConnectionStats | null> {
  try {
    const all = await listConnections();
    const byStatus = Object.fromEntries(CONNECTION_STATUSES.map((s) => [s, 0])) as Record<ConnectionStatus, number>;
    for (const c of all) byStatus[c.status] += 1;
    return { total: all.length, byStatus };
  } catch (err) {
    if (err instanceof SheetsError && err.code === "schema_invalid") return null;
    throw err;
  }
}

/**
 * `options.notify: false` is for automated bulk adds (the Network Finder sends ONE summary per batch instead
 * of one push per contact). Every manual add keeps notifying exactly as before (the default).
 */
export async function createConnection(memberId: MemberId, input: CreateConnectionInput, now: Date = new Date(), options: { notify?: boolean } = {}): Promise<Connection> {
  const stamp = nowIso(now);
  const connection: Connection = {
    connectionId: newId("conn"),
    memberId,
    name: input.name,
    company: input.company,
    role: input.role,
    email: input.email,
    profileUrl: input.profileUrl,
    otherUrl: input.otherUrl,
    message: input.message,
    notes: input.notes,
    status: input.status,
    createdAt: stamp,
    updatedAt: stamp,
  };
  await withWriteLock(() => appendConnection(connection));
  // Only after the row is saved; never fails or delays the save (see notify.ts).
  if (options.notify !== false) await notifyConnectionAdded(memberId, connection);
  return connection;
}

const NOT_OWNER = "Only the member who added this connection (or the administrator) can change it.";

/**
 * Edits a connection. Everyone can see the list, but only the member who added an entry, or the administrator, may change it.
 * The owner (MemberID), the id and the creation time never change, so Gmail drafts (keyed by connection id) are not repeated.
 */
export async function updateConnection(memberId: MemberId, connectionId: string, input: UpdateConnectionInput, now: Date = new Date()): Promise<Connection> {
  const result = await withWriteLock(async () => {
    const { items } = await readConnectionsLocated({ fresh: true });
    const hit = items.find((i) => i.value.connectionId === connectionId);
    if (!hit) throw new DomainError("connection_not_found", "Connection not found.");
    if (hit.value.memberId !== memberId && !isAdmin(memberId)) throw new DomainError("not_connection_owner", NOT_OWNER);
    const next: Connection = { ...hit.value, updatedAt: nowIso(now) };
    // Only the fields present in the request change; an empty optional value clears it.
    for (const key of ["name", "company", "role", "email", "profileUrl", "otherUrl", "message", "notes", "status"] as const) {
      if (key in input) (next as unknown as Record<string, unknown>)[key] = input[key];
    }
    await updateConnectionRow(hit.row, next);
    return { next, foreign: hit.value.memberId !== memberId };
  });
  if (result.foreign) await recordActivity(memberId, "admin_edit", connectionId, now);
  return result.next;
}

/** Deletes a connection (its owner, or the administrator). Draft-ledger rows and Gmail drafts are history and are left alone. */
export async function deleteConnection(memberId: MemberId, connectionId: string, now: Date = new Date()): Promise<{ connectionId: string }> {
  const foreign = await withWriteLock(async () => {
    const { items } = await readConnectionsLocated({ fresh: true });
    const hit = items.find((i) => i.value.connectionId === connectionId);
    if (!hit) throw new DomainError("connection_not_found", "Connection not found.");
    if (hit.value.memberId !== memberId && !isAdmin(memberId)) throw new DomainError("not_connection_owner", NOT_OWNER);
    await deleteTabRows("connections", [hit.row]);
    return hit.value.memberId !== memberId;
  });
  if (foreign) await recordActivity(memberId, "admin_delete", connectionId, now);
  return { connectionId };
}
