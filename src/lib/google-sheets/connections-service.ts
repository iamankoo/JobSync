import "server-only";
import type { MemberId } from "@/config/members";
import type { Connection } from "@/types/domain";
import { nowIso } from "@/lib/utils/time";
import type { CreateConnectionInput, UpdateConnectionInput } from "@/lib/validation/connections";
import { DomainError } from "./errors";
import { newId } from "./ids";
import { withWriteLock } from "./lock";
import { appendConnection, deleteTabRows, readConnectionsLocated, updateConnectionRow } from "./repositories";

/** The SHARED connections list (everyone's entries, like Jobs), most recently touched first. */
export async function listConnections(): Promise<Connection[]> {
  const { items } = await readConnectionsLocated();
  return items.map((i) => i.value).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createConnection(memberId: MemberId, input: CreateConnectionInput, now: Date = new Date()): Promise<Connection> {
  const stamp = nowIso(now);
  const connection: Connection = {
    connectionId: newId("conn"),
    memberId,
    name: input.name,
    company: input.company,
    role: input.role,
    profileUrl: input.profileUrl,
    otherUrl: input.otherUrl,
    message: input.message,
    notes: input.notes,
    status: input.status,
    createdAt: stamp,
    updatedAt: stamp,
  };
  await withWriteLock(() => appendConnection(connection));
  return connection;
}

/** Edits a connection. Everyone can see the list, but only the member who added an entry may change it. */
export async function updateConnection(memberId: MemberId, connectionId: string, input: UpdateConnectionInput, now: Date = new Date()): Promise<Connection> {
  return withWriteLock(async () => {
    const { items } = await readConnectionsLocated({ fresh: true });
    const hit = items.find((i) => i.value.connectionId === connectionId);
    if (!hit) throw new DomainError("connection_not_found", "Connection not found.");
    if (hit.value.memberId !== memberId) throw new DomainError("not_connection_owner", "Only the member who added this connection can change it.");
    const next: Connection = { ...hit.value, updatedAt: nowIso(now) };
    // Only the fields present in the request change; an empty optional value clears it.
    for (const key of ["name", "company", "role", "profileUrl", "otherUrl", "message", "notes", "status"] as const) {
      if (key in input) (next as unknown as Record<string, unknown>)[key] = input[key];
    }
    await updateConnectionRow(hit.row, next);
    return next;
  });
}

export async function deleteConnection(memberId: MemberId, connectionId: string): Promise<{ connectionId: string }> {
  return withWriteLock(async () => {
    const { items } = await readConnectionsLocated({ fresh: true });
    const hit = items.find((i) => i.value.connectionId === connectionId);
    if (!hit) throw new DomainError("connection_not_found", "Connection not found.");
    if (hit.value.memberId !== memberId) throw new DomainError("not_connection_owner", "Only the member who added this connection can change it.");
    await deleteTabRows("connections", [hit.row]);
    return { connectionId };
  });
}
