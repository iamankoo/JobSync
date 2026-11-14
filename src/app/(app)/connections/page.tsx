import { ConnectionsBrowser } from "@/components/connections/connections-browser";
import { PageHeader } from "@/components/layout/page-header";
import { ErrorState } from "@/components/ui/empty-state";
import { listConnections } from "@/lib/google-sheets/connections-service";
import { loadForMember } from "@/lib/pages/load";
import { ID_PATTERN } from "@/lib/validation/applications";

export const metadata = { title: "Connections · JobSync" };

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ connection?: string | string[] }> }) {
  // Notification links open one Connection's details: `?connection=<ConnectionID>` (well-formed IDs only).
  const { connection } = await searchParams;
  const connectionId = typeof connection === "string" && ID_PATTERN.test(connection) ? connection : undefined;
  // The shared list (all members' entries); the session still has to be valid and active.
  const { memberId, timeZone, result } = await loadForMember(() => listConnections());

  if (!result.ok) {
    return (
      <div className="space-y-5">
        <PageHeader title="Connections" subtitle="Whom should I connect with, and what message should I send?" />
        <ErrorState title={result.title} message={result.message} />
      </div>
    );
  }
  return <ConnectionsBrowser key={connectionId ?? ""} connections={result.data} me={memberId} timeZone={timeZone} initialConnectionId={connectionId} />;
}
