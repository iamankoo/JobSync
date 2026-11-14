import type { Connection } from "@/types/domain";

/**
 * Connections that JobSync's automation created (imported from the Outreach Database, or found by the Network Finder) rather than a member.
 * They still have a member as their stored owner (MemberID, needed for the sheet schema and edit rights), but are shown as "Added by JobSync".
 * The marker is the first line of the notes, written by the importer / Network Finder and never by the add form.
 */
export function addedByJobSync(c: Pick<Connection, "notes">): boolean {
  const notes = c.notes ?? "";
  return notes.startsWith("Source: Outreach Database") || notes.startsWith("Source: Network Finder");
}

export const JOBSYNC_ADDER_LABEL = "JobSync";
