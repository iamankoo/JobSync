import { JobsBrowser } from "@/components/jobs/jobs-browser";
import { PageHeader } from "@/components/layout/page-header";
import { ErrorState } from "@/components/ui/empty-state";
import { listJobsForMember } from "@/lib/google-sheets/jobs-service";
import { loadForMember } from "@/lib/pages/load";

export const metadata = { title: "All Jobs · JobSync" };

export default async function AllJobsPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const { q } = await searchParams;
  const query = typeof q === "string" ? q.slice(0, 200) : "";
  // The member comes from the validated session inside loadForMember, never from the request.
  const { memberId, timeZone, today, result } = await loadForMember(listJobsForMember);

  if (!result.ok) {
    return (
      <div className="space-y-5">
        <PageHeader title="All Jobs" subtitle="Explore all job opportunities" />
        <ErrorState title={result.title} message={result.message} />
      </div>
    );
  }
  return <JobsBrowser key={query} currentMemberId={memberId} jobs={result.data.jobs} skippedRows={result.data.skippedRows} initialQuery={query} timeZone={timeZone} today={today} />;
}
