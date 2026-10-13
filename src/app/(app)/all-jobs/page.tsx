import { JobsBrowser } from "@/components/jobs/jobs-browser";
import { PageHeader } from "@/components/layout/page-header";
import { ErrorState } from "@/components/ui/empty-state";
import { listJobsForMember } from "@/lib/google-sheets/jobs-service";
import { loadForMember } from "@/lib/pages/load";
import { ID_PATTERN } from "@/lib/validation/applications";

export const metadata = { title: "All Jobs · JobSync" };

export default async function AllJobsPage({ searchParams }: { searchParams: Promise<{ q?: string | string[]; job?: string | string[] }> }) {
  const { q, job } = await searchParams;
  const query = typeof q === "string" ? q.slice(0, 200) : "";
  // Notification links open one job's details: `?job=<JobID>` (well-formed IDs only).
  const jobId = typeof job === "string" && ID_PATTERN.test(job) ? job : undefined;
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
  return <JobsBrowser key={`${query}|${jobId ?? ""}`} initialJobId={jobId} currentMemberId={memberId} jobs={result.data.jobs} skippedRows={result.data.skippedRows} initialQuery={query} timeZone={timeZone} today={today} />;
}
