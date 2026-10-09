import { AddJobForm } from "@/components/jobs/add-job-form";
import { PageHeader } from "@/components/layout/page-header";
import { ErrorState } from "@/components/ui/empty-state";
import { listJobsForMember } from "@/lib/google-sheets/jobs-service";
import { distinctValues } from "@/lib/jobs/query";
import { loadForMember } from "@/lib/pages/load";

export const metadata = { title: "Add Job · JobSync" };

export default async function AddJobPage() {
  const { timeZone, result } = await loadForMember(listJobsForMember);

  if (!result.ok) {
    return (
      <div className="space-y-5">
        <PageHeader title="Add New Job" subtitle="Share a new job opportunity with the team" />
        <ErrorState title={result.title} message={result.message} />
      </div>
    );
  }
  const { jobs } = result.data;
  // Strip the per-member status: the form only needs shared job fields.
  const recentJobs = jobs.slice(0, 5).map(({ myStatus: _status, ...job }) => {
    void _status;
    return job;
  });
  return <AddJobForm recentJobs={recentJobs} locations={distinctValues(jobs.map((j) => j.location))} timeZone={timeZone} />;
}
