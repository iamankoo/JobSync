import { AnalyticsView } from "@/components/analytics/analytics-view";
import { PageHeader } from "@/components/layout/page-header";
import { ErrorState } from "@/components/ui/empty-state";
import { getAnalyticsSource } from "@/lib/google-sheets/insights-service";
import { loadForMember } from "@/lib/pages/load";

export const metadata = { title: "Analytics · JobSync" };

export default async function AnalyticsPage() {
  // Only the signed-in member's own applications and activity are loaded.
  const { timeZone, result } = await loadForMember((m) => getAnalyticsSource(m));

  if (!result.ok) {
    return (
      <div className="space-y-5">
        <PageHeader title="Analytics" subtitle="Insights into your job search progress" />
        <ErrorState title={result.title} message={result.message} />
      </div>
    );
  }
  return <AnalyticsView source={result.data} timeZone={timeZone} />;
}
