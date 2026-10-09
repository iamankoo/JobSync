import type { Application, ApplicationStatus, Job, JobWithMyStatus, MyApplicationRow } from "@/types/domain";

/** Clearly synthetic fixtures for isolated tests. They are never written anywhere. */
export const TODAY = "2026-10-09";
export const TZ = "Asia/Kolkata";

export function makeJob(n: number, over: Partial<Job> = {}): Job {
  return {
    jobId: `job_${n}`,
    company: `Synthetic Co ${n}`,
    jobRole: `Test Role ${n}`,
    jobType: n % 2 === 0 ? "Internship" : "Full-time",
    location: n % 3 === 0 ? "Testville" : "Sampleton",
    jobUrl: `https://jobs.example.test/${n}`,
    experience: n % 2 === 0 ? "0–1 years" : "1–3 years",
    stipendSalary: `Test pay ${n}`,
    deadline: `2026-10-${String(10 + n).padStart(2, "0")}`,
    description: `Synthetic description ${n}`,
    addedBy: "anni",
    // later n = more recent
    addedAt: `2026-10-${String(1 + (n % 8)).padStart(2, "0")}T10:${String(n % 60).padStart(2, "0")}:00.000Z`,
    ...over,
  };
}

export function makeJobs(count: number, statuses: Record<number, ApplicationStatus> = {}): JobWithMyStatus[] {
  return Array.from({ length: count }, (_, i) => ({ ...makeJob(i + 1), myStatus: statuses[i + 1] ?? "Not Applied" }));
}

export function makeApplication(n: number, status: ApplicationStatus, over: Partial<Application> = {}): Application {
  return {
    jobId: `job_${n}`,
    memberId: "anni",
    status,
    appliedAt: `2026-10-0${(n % 8) + 1}T08:00:00.000Z`,
    lastUpdated: `2026-10-0${(n % 8) + 1}T09:00:00.000Z`,
    ...over,
  };
}

export function makeRows(specs: [number, ApplicationStatus][]): MyApplicationRow[] {
  return specs.map(([n, status]) => ({ job: makeJob(n), application: makeApplication(n, status) }));
}

/** A fetch mock returning the standard `{ data }` envelope or `{ error }` envelope. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
