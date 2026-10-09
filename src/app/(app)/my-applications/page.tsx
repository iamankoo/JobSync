import { ApplicationsBrowser } from "@/components/applications/applications-browser";
import { PageHeader } from "@/components/layout/page-header";
import { ErrorState } from "@/components/ui/empty-state";
import { listMyApplications } from "@/lib/google-sheets/applications-service";
import { loadForMember } from "@/lib/pages/load";

export const metadata = { title: "My Applications · JobSync" };

export default async function MyApplicationsPage() {
  // Only the signed-in member's own applications are loaded; the member comes from the session.
  const { timeZone, today, result } = await loadForMember(listMyApplications);

  if (!result.ok) {
    return (
      <div className="space-y-5">
        <PageHeader title="My Applications" subtitle="Track and manage all the jobs you've applied to" />
        <ErrorState title={result.title} message={result.message} />
      </div>
    );
  }
  return <ApplicationsBrowser rows={result.data.rows} skipped={result.data.skipped} timeZone={timeZone} today={today} />;
}
