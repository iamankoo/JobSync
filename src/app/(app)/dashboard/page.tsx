import { DashboardView } from "@/components/dashboard/dashboard-view";
import { PageHeader } from "@/components/layout/page-header";
import { ErrorState } from "@/components/ui/empty-state";
import { getMember } from "@/config/members";
import { connectionStats } from "@/lib/google-sheets/connections-service";
import { getDashboardData } from "@/lib/google-sheets/insights-service";
import { loadForMember } from "@/lib/pages/load";

export const metadata = { title: "Dashboard · JobSync" };

export default async function DashboardPage() {
  // The member comes from the validated session inside loadForMember, never from the request.
  const { memberId, timeZone, result } = await loadForMember(async (m) => {
    const [data, connections] = await Promise.all([getDashboardData(m), connectionStats()]);
    return { data, connections };
  });
  const member = getMember(memberId)!;

  if (!result.ok) {
    return (
      <div className="space-y-5">
        <PageHeader title={`Welcome back, ${member.name}`} subtitle="Let's find your next opportunity." />
        <ErrorState title={result.title} message={result.message} />
      </div>
    );
  }
  return <DashboardView member={member} data={result.data.data} connections={result.data.connections} timeZone={timeZone} />;
}
