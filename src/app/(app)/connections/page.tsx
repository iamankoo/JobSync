import { ConnectionsBrowser } from "@/components/connections/connections-browser";
import { PageHeader } from "@/components/layout/page-header";
import { ErrorState } from "@/components/ui/empty-state";
import { listConnections } from "@/lib/google-sheets/connections-service";
import { loadForMember } from "@/lib/pages/load";

export const metadata = { title: "Connections · JobSync" };

export default async function ConnectionsPage() {
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
  return <ConnectionsBrowser connections={result.data} me={memberId} timeZone={timeZone} />;
}
