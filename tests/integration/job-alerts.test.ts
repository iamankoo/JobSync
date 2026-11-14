/**
 * REGRESSION (1 Nov 2026): jobs the daily search saved never notified the other members (`notify: false`, meant for a batch summary
 * that no longer exists). A saved job — manual or discovered — must tell exactly the OTHER two members, once, after the row is saved.
 * Real push layer and Jobs service; devices are fake endpoints; the delivery function is controlled by the test. Nothing real is contacted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { POST as postJob } from "@/app/api/jobs/route";
import { POST as postSub } from "@/app/api/push/subscriptions/route";
import { MEMBER_IDS, type MemberId } from "@/config/members";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { loadNetworkFinderConfig } from "@/lib/network-finder/config";
import { existingConnections, existingJobs, type JobsGateway } from "@/lib/network-finder/gateways";
import { MAX_ATTEMPTS, flushJobAlerts, queueJobAlert, type AlertSender } from "@/lib/network-finder/job-alerts";
import { runDailyJobSearch, type CompanyTask, type PipelineDeps } from "@/lib/network-finder/pipeline";
import { InMemoryQueue } from "@/lib/network-finder/queue";
import { InMemoryCompanyRegistry } from "@/lib/network-finder/registry";
import { InMemoryBatchLedger } from "@/lib/network-finder/scheduler";
import type { JobCandidate } from "@/lib/network-finder/types";
import { loadVapidConfig } from "@/lib/push/config";
import { notifyMember, resetPushDedupeForTesting, setPushSenderForTesting, type PushSender } from "@/lib/push/notify";
import { FakeSheets } from "../helpers/fake-sheets";
import { MockJobSource } from "../helpers/network-finder-mocks";

const NOON_IST = Date.UTC(2026, 10, 1, 6, 30);
let sheets: FakeSheets;
let delivered: { member: MemberId; title: string; body: string; url: string; tag: string }[];
let failFor: Set<MemberId>;
let goneFor: Set<MemberId>;

const as = (m: MemberId | null) => vi.mocked(getSession).mockResolvedValue(m ? { memberId: m, expiresAt: 9_999_999_999 } : null);
const req = (url: string, method: string, data?: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json", host: "localhost" }, body: data === undefined ? undefined : JSON.stringify(data) });
async function subscribe(m: MemberId) {
  as(m);
  const res = await postSub(req("/api/push/subscriptions", "POST", { endpoint: `https://fcm.googleapis.com/fcm/send/${m}-device-1`, keys: { p256dh: "BPk1234567890abcd", auth: "auth1234567890" } }));
  expect(res.status).toBeLessThan(300);
}

beforeEach(async () => {
  vi.stubEnv("VAPID_PUBLIC_KEY", "test-public-key");
  vi.stubEnv("VAPID_PRIVATE_KEY", "test-private-key");
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
  resetPushDedupeForTesting();
  delivered = [];
  failFor = new Set();
  goneFor = new Set();
  const sender: PushSender = async (sub, payload) => {
    if (goneFor.has(sub.memberId)) return { ok: false, gone: true, status: 410 };
    if (failFor.has(sub.memberId)) return { ok: false, gone: false, status: 503 };
    delivered.push({ member: sub.memberId, ...payload });
    return { ok: true };
  };
  setPushSenderForTesting(sender);
  for (const m of MEMBER_IDS) await subscribe(m);
});
afterEach(() => {
  setSheetsClientForTesting(null);
  setPushSenderForTesting(null);
  vi.mocked(getSession).mockReset();
  vi.unstubAllEnvs();
});

/** The real delivery path, exactly as run.ts wires it. */
const send: AlertSender = async (member, payload) => {
  if (!loadVapidConfig()) throw new Error("push not configured");
  return notifyMember(member, payload);
};

let seq = 0;
function job(kind: "internship" | "full_time", over: Partial<JobCandidate> = {}): JobCandidate {
  const n = ++seq;
  const intern = kind === "internship";
  return {
    source: "Greenhouse", companyName: `Alert Co ${n}`, title: intern ? "Full Stack Engineering Intern" : "Full Stack Engineer, New Grad", url: `https://boards.greenhouse.io/alert${n}/jobs/${n}`,
    location: "Remote - Worldwide, Germany", remote: true, workplace: "remote", postedAt: new Date(NOON_IST - 86_400_000).toISOString(),
    description: "New grads welcome. B.Tech / B.E. students graduating in 2027. React and Node.js.",
    salary: intern ? { max: 80_000, currency: "INR", period: "month" } : { max: 1_800_000, currency: "INR", period: "year" }, ...(intern ? { employment: "internship" as const } : {}), ...over,
  };
}

function setup(ledger = new InMemoryBatchLedger(), jobsGateway: JobsGateway = existingJobs) {
  const jobSource = new MockJobSource();
  const deps: PipelineDeps = {
    config: loadNetworkFinderConfig({ DRAFT_DELAY_MINUTES: "0", NETWORK_FINDER_ENABLED: "true", APP_TIMEZONE: "Asia/Kolkata" } as unknown as NodeJS.ProcessEnv),
    sources: [], jobSources: [jobSource], seedBoards: [], jobAlerts: { send },
    queue: new InMemoryQueue<CompanyTask>(), registry: new InMemoryCompanyRegistry(), ledger, connections: existingConnections, jobs: jobsGateway, now: () => new Date(NOON_IST),
  };
  return { deps, jobSource, ledger };
}
const rows = () => sheets.dataRows("Jobs").map((r) => ({ id: r[0], company: r[1], role: r[2], type: r[3], by: r[11] as MemberId }));
const forJob = (id: string) => delivered.filter((d) => d.url === `/all-jobs?job=${id}`);

describe("jobs saved by the daily search notify the other two members, once", () => {
  it("every member's job: exactly two notifications, to the other two, with company, role, job type and a link — and no claim that the member added it", async () => {
    const { deps, jobSource, ledger } = setup();
    jobSource.searchResults = [job("full_time"), job("full_time"), job("full_time")];
    await runDailyJobSearch(deps);
    const saved = rows();
    expect(saved.map((r) => r.by).sort()).toEqual(["anni", "lukky", "rishii"]); // one per member: all three combinations
    expect(delivered).toHaveLength(0); // nothing yet: the cron's flush step sends
    await flushJobAlerts(ledger, send);
    expect(delivered).toHaveLength(6);
    const names = { anni: "Anni", lukky: "Lukky", rishii: "Rishii" };
    for (const r of saved) {
      const got = forJob(r.id);
      expect(got.map((g) => g.member).sort(), `${r.by}'s job`).toEqual(MEMBER_IDS.filter((m) => m !== r.by).sort());
      for (const g of got) {
        expect(g.title).toContain(`found for ${names[r.by]}`);
        expect(g.title).toContain(r.role);
        expect(g.title).not.toMatch(/added a job/);
        expect(g.body).toContain(r.company);
        expect(g.body).toContain("Full-time");
        expect(g.url).toBe(`/all-jobs?job=${r.id}`);
      }
    }
  });

  it("saved jobs are visible to all three members in All Jobs (not applied), credited to the member they were saved under", async () => {
    const { listJobsForMember } = await import("@/lib/google-sheets/jobs-service");
    const { deps, jobSource } = setup();
    jobSource.searchResults = [job("full_time"), job("full_time"), job("internship")];
    await runDailyJobSearch(deps);
    const saved = rows();
    expect(saved).toHaveLength(3);
    for (const m of MEMBER_IDS) {
      const { jobs, skippedRows } = await listJobsForMember(m);
      expect(skippedRows).toBe(0);
      expect(jobs.map((j) => j.jobId).sort()).toEqual(saved.map((s) => s.id).sort());
      expect(jobs.every((j) => j.myStatus === "Not Applied")).toBe(true);
    }
  });

  it("an internship says so", async () => {
    const { deps, jobSource, ledger } = setup();
    jobSource.searchResults = [job("internship")];
    await runDailyJobSearch(deps);
    await flushJobAlerts(ledger, send);
    expect(delivered).toHaveLength(2);
    expect(delivered[0].title).toMatch(/^New internship found for/);
    expect(delivered[0].body).toContain("Internship");
  });

  it("nothing is sent for a rejected listing, a duplicate, or a failed write", async () => {
    const { deps, jobSource, ledger } = setup();
    const dup = job("full_time", { companyName: "Already Here" });
    await existingJobs.create("lukky", { company: "Already Here", jobRole: dup.title, jobType: "Full-time", location: "Germany", jobUrl: dup.url });
    jobSource.searchResults = [dup, job("full_time", { location: "Remote - US", remote: true }), job("full_time", { description: "Master's students only, graduating in 2027." })];
    const r = await runDailyJobSearch(deps);
    expect(rows()).toHaveLength(1); // only the pre-existing one
    expect(r.report!.full_time.saved).toHaveLength(0);
    await flushJobAlerts(ledger, send);
    expect(delivered).toHaveLength(0);

    // a Sheets write failure: the save throws, nothing is queued, nobody is told
    const failing: JobsGateway = { list: () => existingJobs.list(), create: async () => Promise.reject(new Error("socket hang up")) };
    const b = setup(new InMemoryBatchLedger(), failing);
    b.jobSource.searchResults = [job("full_time")];
    await expect(runDailyJobSearch(b.deps)).rejects.toThrow("socket hang up");
    await flushJobAlerts(b.ledger, send);
    expect(delivered).toHaveLength(0);
    expect(await b.ledger.getNote!("job-alerts")).toBeUndefined();
  });

  it("cron retry and restart: a second call, a new process, or a repeated flush never notifies anyone twice", async () => {
    const ledger = new InMemoryBatchLedger();
    const a = setup(ledger);
    a.jobSource.searchResults = [job("full_time"), job("full_time")];
    await runDailyJobSearch(a.deps);
    await flushJobAlerts(ledger, send);
    await flushJobAlerts(ledger, send);
    expect(delivered).toHaveLength(4);
    const again = setup(ledger); // restart: only the durable ledger and the sheet remain
    again.jobSource.searchResults = a.jobSource.searchResults;
    await runDailyJobSearch(again.deps);
    await flushJobAlerts(ledger, send);
    expect(delivered).toHaveLength(4);
    expect(new Set(delivered.map((d) => `${d.member}|${d.url}`)).size).toBe(4); // each recipient, each job, once
  });

  it("a crash after the save but before the flush loses nothing and duplicates nothing", async () => {
    const ledger = new InMemoryBatchLedger();
    const a = setup(ledger);
    a.jobSource.searchResults = [job("full_time")];
    await runDailyJobSearch(a.deps); // killed here: saved + queued, not yet delivered
    expect(delivered).toHaveLength(0);
    const after = await flushJobAlerts(ledger, send); // the next cron call
    expect(after).toMatchObject({ handled: 2, pending: 0 });
    await flushJobAlerts(ledger, send);
    expect(delivered).toHaveLength(2);
  });

  it("a delivery failure is retried for that recipient only; the other is not notified twice", async () => {
    const ledger = new InMemoryBatchLedger();
    const a = setup(ledger);
    a.jobSource.searchResults = [job("full_time")];
    await runDailyJobSearch(a.deps);
    const creator = rows()[0].by;
    const [x, y] = MEMBER_IDS.filter((m) => m !== creator);
    failFor.add(y);
    const first = await flushJobAlerts(ledger, send);
    expect(first).toMatchObject({ handled: 1, pending: 1 });
    expect(delivered.map((d) => d.member)).toEqual([x]);
    failFor.clear();
    const second = await flushJobAlerts(ledger, send);
    expect(second).toMatchObject({ handled: 1, pending: 0 });
    expect(delivered.map((d) => d.member).sort()).toEqual([x, y].sort()); // x once, y once
    await flushJobAlerts(ledger, send);
    expect(delivered).toHaveLength(2);
  });

  it("an expired device or a member with no device is handled (nothing to retry); an unreadable/unconfigured push layer is retried then given up", async () => {
    const ledger = new InMemoryBatchLedger();
    await queueJobAlert(ledger, { jobId: "job_gone", creator: "anni", company: "Gone Co", role: "Engineer", jobType: "Full-time" });
    goneFor.add("rishii");
    expect(await flushJobAlerts(ledger, send)).toMatchObject({ handled: 2, pending: 0 }); // lukky delivered, rishii's device expired
    // push not configured: retried up to MAX_ATTEMPTS, never delivered, then dropped
    vi.stubEnv("VAPID_PUBLIC_KEY", "");
    await queueJobAlert(ledger, { jobId: "job_cfg", creator: "lukky", company: "Cfg Co", role: "Engineer", jobType: "Internship" });
    let last = await flushJobAlerts(ledger, send);
    for (let i = 1; i < MAX_ATTEMPTS; i++) last = await flushJobAlerts(ledger, send);
    expect(last).toMatchObject({ pending: 0, dropped: 1 });
    expect(delivered.filter((d) => d.url.includes("job_cfg"))).toHaveLength(0);
  });

  it("queuing the same job twice queues it once", async () => {
    const ledger = new InMemoryBatchLedger();
    const facts = { jobId: "job_x", creator: "rishii" as const, company: "X", role: "Engineer", jobType: "Full-time" };
    await queueJobAlert(ledger, facts);
    await queueJobAlert(ledger, facts);
    await flushJobAlerts(ledger, send);
    expect(delivered.filter((d) => d.url.includes("job_x"))).toHaveLength(2);
  });
});

describe("manually added jobs still notify the other two members (unchanged mechanism)", () => {
  for (const actor of MEMBER_IDS) {
    it(`${actor} adds a job: the other two are notified, the actor is not`, async () => {
      as(actor);
      const res = await postJob(req("/api/jobs", "POST", { company: "Manual Co", jobRole: "Backend Engineer", jobType: "Full-time", location: "Testville", jobUrl: `https://jobs.example.test/manual-${actor}` }));
      expect(res.status).toBe(201);
      expect(delivered.map((d) => d.member).sort()).toEqual(MEMBER_IDS.filter((m) => m !== actor).sort());
      expect(delivered[0].title).toContain("added a job");
    });
  }
});
