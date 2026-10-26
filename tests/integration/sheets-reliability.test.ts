/**
 * Reliability of the REAL Google client (client.ts) under quota errors, timeouts and concurrency.
 * `@googleapis/sheets` is replaced by a fake API backed by the in-memory FakeSheets store, so the
 * request batching, retry/backoff and write-safety rules run exactly as in production.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setRetrySleepForTesting, setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { recordVisit } from "@/lib/google-sheets/activity-service";
import { setApplicationStatus } from "@/lib/google-sheets/applications-service";
import { markRead, sendTextMessage } from "@/lib/google-sheets/chat-service";
import { createConnection } from "@/lib/google-sheets/connections-service";
import { answerFollowUp, getDueFollowUps } from "@/lib/google-sheets/follow-up-service";
import { getDashboardData } from "@/lib/google-sheets/insights-service";
import { createJob, deleteJob } from "@/lib/google-sheets/jobs-service";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { readActivity, readApplications, readChatMessagesLocated, readJobs, readMembers } from "@/lib/google-sheets/repositories";
import { setTableCacheTtlForTesting } from "@/lib/google-sheets/table";
import type { CreateJobInput } from "@/lib/validation/jobs";
import { FakeSheets } from "../helpers/fake-sheets";

type Op = "get" | "batchGet" | "append" | "update" | "meta" | "batchUpdate";
/** A planned failure: `after` = the request WAS executed and then the reply was lost (ambiguous). */
type Fault = { status: number; after?: boolean };

const h = vi.hoisted(() => ({
  store: null as unknown as import("../helpers/fake-sheets").FakeSheets,
  calls: [] as { op: string; detail: string }[],
  plan: new Map<string, { status: number; after?: boolean }[]>(),
  /** Called for every request; may return a fault (for random/probabilistic injection). */
  chaos: null as null | ((op: string) => { status: number; after?: boolean } | undefined),
}));

vi.mock("@googleapis/sheets", () => {
  // Same shape as helpers/fake-sheets googleError (not imported here: that helper imports the mocked module).
  const gErr = (status: number) => Object.assign(new Error(`google ${status}`), { code: status, response: { status, data: { error: { errors: [] } } } });
  const nextFault = (op: string) => h.plan.get(op)?.shift() ?? h.chaos?.(op);
  async function run<T>(op: string, detail: string, exec: () => Promise<T>): Promise<T> {
    h.calls.push({ op, detail });
    const fault = nextFault(op);
    if (fault && !fault.after) throw gErr(fault.status);
    const result = await exec();
    if (fault?.after) throw gErr(fault.status);
    return result;
  }
  const titles = () => [...h.store.tabs.keys()];
  const api = {
    spreadsheets: {
      values: {
        get: (p: { range: string }) => run("get", p.range, async () => ({ data: { values: await h.store.getValues(p.range) } })),
        batchGet: (p: { ranges: string[] }) =>
          run("batchGet", p.ranges.join(","), async () => {
            const valueRanges = [];
            for (const r of p.ranges) valueRanges.push({ range: r, values: await h.store.getValues(r) });
            return { data: { valueRanges } };
          }),
        append: (p: { range: string; requestBody: { values: string[][] } }) =>
          run("append", p.range, async () => h.store.appendValues(p.range, p.requestBody.values)),
        update: (p: { range: string; requestBody: { values: string[][] } }) =>
          run("update", p.range, async () => h.store.updateValues(p.range, p.requestBody.values)),
      },
      get: () => run("meta", "", async () => ({ data: { sheets: titles().map((title, sheetId) => ({ properties: { title, sheetId } })) } })),
      batchUpdate: (p: { requestBody: { requests: { deleteDimension: { range: { sheetId: number; startIndex: number } } }[] } }) =>
        run("batchUpdate", "", async () => {
          const reqs = p.requestBody.requests;
          // Requests arrive highest row first, exactly as the real API would apply them.
          for (const r of reqs) await h.store.deleteRows(titles()[r.deleteDimension.range.sheetId], [r.deleteDimension.range.startIndex + 1]);
          return { data: {} };
        }),
    },
  };
  return { auth: { JWT: class {} }, sheets: () => api };
});

const ENV = {
  GOOGLE_SHEETS_SPREADSHEET_ID: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  GOOGLE_SERVICE_ACCOUNT_EMAIL: "svc@proj.iam.gserviceaccount.com",
  GOOGLE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nTESTKEY\\n-----END PRIVATE KEY-----\\n",
};
const saved: Record<string, string | undefined> = {};
let sleeps: number[] = [];

const T0 = new Date("2026-10-01T10:00:00.000Z");
const later = (h: number) => new Date(T0.getTime() + h * 3_600_000);
const input = (n: number): CreateJobInput => ({ company: `Synthetic Co ${n}`, jobRole: `Role ${n}`, jobType: "Internship", location: "Testville", jobUrl: `https://jobs.example.test/${n}` });
const count = (op: Op) => h.calls.filter((c) => c.op === op).length;
const reads = () => count("get") + count("batchGet");
const plan = (op: Op, ...faults: Fault[]) => h.plan.set(op, faults);
const rows = (tab: string) => h.store.dataRows(tab);
const unique = (xs: string[]) => new Set(xs).size === xs.length;

beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(() => {
  h.store = new FakeSheets().seedMembers();
  h.calls = [];
  h.plan.clear();
  h.chaos = null;
  sleeps = [];
  setSheetsClientForTesting(null); // build a fresh REAL client against the mocked API
  resetMembersCache();
  setRetrySleepForTesting(async (ms) => void sleeps.push(ms));
});
afterEach(() => {
  setRetrySleepForTesting(null);
  setTableCacheTtlForTesting(null);
  setSheetsClientForTesting(null);
});

describe("read batching (one quota unit for many tabs)", () => {
  it("reads issued together become ONE batchGet request, each caller getting its own tab", async () => {
    await createJob("anni", input(1), T0);
    h.calls = [];
    const [jobs, apps, members, activity] = await Promise.all([readJobs(), readApplications(), readMembers(), readActivity()]);
    expect(count("batchGet")).toBe(1);
    expect(count("get")).toBe(0);
    expect(jobs.items.map((j) => j.company)).toEqual(["Synthetic Co 1"]);
    expect(apps.items).toEqual([]);
    expect(members.items).toHaveLength(3);
    expect(activity.items.map((a) => a.action)).toEqual(["job_added"]);
  });

  it("a dashboard render plus the layout's checks costs 1 read instead of ~7", async () => {
    await Promise.all([getDashboardData("anni", T0), getDueFollowUps("anni", T0), recordVisit("anni", T0)]);
    expect(reads()).toBe(1);
  });

  it("a missing optional tab only fails its own caller, not the others in the same batch", async () => {
    h.store.tabs.delete("ChatMessages");
    const [jobs, chat] = await Promise.allSettled([readJobs(), readChatMessagesLocated()]);
    expect(jobs.status).toBe("fulfilled");
    expect(chat).toMatchObject({ status: "rejected", reason: { code: "schema_invalid" } });
  });

  it("the visit check does not re-read Activity on every render once a recent visit is known", async () => {
    expect(await recordVisit("anni", T0)).toBe(true);
    h.calls = [];
    for (let i = 1; i <= 20; i++) expect(await recordVisit("anni", new Date(T0.getTime() + i * 30_000))).toBe(false);
    expect(reads()).toBe(0);
    expect(rows("Activity").filter((r) => r[3] === "visit")).toHaveLength(1);
  });

  it("concurrent identical reads share one in-flight request", async () => {
    setTableCacheTtlForTesting(5000);
    await Promise.all(Array.from({ length: 10 }, () => readJobs()));
    expect(reads()).toBe(1);
  });
});

describe("transient failures recover automatically", () => {
  it("quota errors (429) on page reads are retried with second-scale backoff and the page loads", async () => {
    plan("batchGet", { status: 429 }, { status: 429 }, { status: 429 });
    const data = await getDashboardData("anni", T0);
    expect(data.totalJobs).toBe(0);
    expect(count("batchGet")).toBe(4);
    expect(sleeps).toHaveLength(3);
    // ~1 s, ~2 s, ~4 s (each ±25 % jitter)
    expect(sleeps[0]).toBeGreaterThanOrEqual(750);
    expect(sleeps[0]).toBeLessThanOrEqual(1250);
    expect(sleeps[1]).toBeGreaterThanOrEqual(1500);
    expect(sleeps[2]).toBeGreaterThanOrEqual(3000);
  });

  it("5xx and timeouts on reads are retried too", async () => {
    plan("batchGet", { status: 503 }, { status: 500 });
    await expect(getDashboardData("anni", T0)).resolves.toBeDefined();
    expect(count("batchGet")).toBe(3);
  });

  it("a quota outage that never clears still ends with the friendly error (bounded, ~15 s of waiting)", async () => {
    h.chaos = (op) => (op === "batchGet" || op === "get" ? { status: 429 } : undefined);
    await expect(getDashboardData("anni", T0)).rejects.toMatchObject({ code: "rate_limited", publicMessage: "The data service is busy. Please try again shortly." });
    expect(count("batchGet")).toBe(5);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(20_000);
  });

  it("permanent errors are not retried", async () => {
    plan("batchGet", { status: 403 });
    await expect(getDashboardData("anni", T0)).rejects.toMatchObject({ code: "permission_denied" });
    expect(count("batchGet")).toBe(1);
  });
});

describe("writes: recovered without losing or duplicating data", () => {
  it("an append rejected by quota (never executed) is retried once and lands exactly once", async () => {
    plan("append", { status: 429 });
    const job = await createJob("anni", input(1), T0);
    expect(rows("Jobs").map((r) => r[0])).toEqual([job.jobId]);
    expect(rows("Activity").map((r) => r[3])).toEqual(["job_added"]);
  });

  it("an ambiguous append failure (executed, reply lost) is NOT retried, so no duplicate row is created", async () => {
    plan("append", { status: 503, after: true });
    await expect(createJob("anni", input(1), T0)).rejects.toMatchObject({ code: "upstream_error" });
    expect(count("append")).toBe(1);
    expect(rows("Jobs")).toHaveLength(1);
  });

  it("row updates (idempotent) are retried after quota and 5xx errors, saving the application once", async () => {
    const job = await createJob("lukky", input(1), T0);
    await setApplicationStatus("anni", job.jobId, { status: "Applied" }, T0);
    plan("update", { status: 429 }, { status: 503, after: true });
    const res = await setApplicationStatus("anni", job.jobId, { status: "Interview" }, later(1));
    expect(res.application?.status).toBe("Interview");
    const mine = rows("Applications").filter((r) => r[0] === job.jobId && r[1] === "anni");
    expect(mine).toHaveLength(1);
    expect(mine[0][2]).toBe("Interview");
  });

  it("saving a follow-up answer survives quota errors on both its reads and its write (the reported bug)", async () => {
    const job = await createJob("lukky", input(1), T0);
    await setApplicationStatus("anni", job.jobId, { status: "Applied" }, T0);
    const activityBefore = rows("Activity").length;
    plan("batchGet", { status: 429 }, { status: 429 });
    plan("update", { status: 429 });
    const res = await answerFollowUp("anni", job.jobId, "Shortlisted", later(169));
    expect(res.changed).toBe(true);
    const app = rows("Applications").filter((r) => r[0] === job.jobId && r[1] === "anni");
    expect(app).toHaveLength(1);
    expect(app[0][4]).toBe("Shortlisted");
    expect(app[0][7]).toBe("Shortlisted");
    // Retrying the same answer is a no-op: no second activity row.
    const again = await answerFollowUp("anni", job.jobId, "Shortlisted", later(170));
    expect(again.changed).toBe(false);
    expect(rows("Activity").length - activityBefore).toBe(1);
  });

  it("a row delete rejected by quota is retried and removes exactly the right rows", async () => {
    const a = await createJob("anni", input(1), T0);
    const b = await createJob("anni", input(2), T0);
    const c = await createJob("anni", input(3), T0);
    await setApplicationStatus("lukky", b.jobId, { status: "Applied" }, T0);
    plan("batchUpdate", { status: 429 });
    await deleteJob("anni", b.jobId, later(1));
    expect(rows("Jobs").map((r) => r[0])).toEqual([a.jobId, c.jobId]);
    expect(rows("Applications").filter((r) => r[0] === b.jobId)).toHaveLength(0);
  });

  it("an ambiguous delete failure is not retried (could remove the wrong rows)", async () => {
    const a = await createJob("anni", input(1), T0);
    plan("batchUpdate", { status: 503 });
    await expect(deleteJob("anni", a.jobId, later(1))).rejects.toMatchObject({ code: "upstream_error" });
    expect(count("batchUpdate")).toBe(1);
    expect(rows("Jobs")).toHaveLength(1);
  });

  it("chat messages, read markers and connections are written once despite quota errors", async () => {
    plan("append", { status: 429 }, { status: 429 });
    const msg = await sendTextMessage("anni", "hello team", T0);
    expect(rows("ChatMessages").map((r) => r[0])).toEqual([msg.messageId]);
    plan("append", { status: 429 });
    await markRead("lukky", 2, T0);
    expect(rows("ChatReads")).toEqual([["lukky", "2", T0.toISOString()]]);
    plan("append", { status: 429 });
    const conn = await createConnection("anni", { name: "Synthetic Person", status: "Not Connected" }, T0);
    expect(rows("Connections").map((r) => r[0])).toEqual([conn.connectionId]);
  });
});

describe("concurrency under random quota errors", () => {
  /** Deterministic pseudo-random quota failures on ~30 % of requests (never "after": 429s are never executed). */
  function quotaChaos(seed: number, rate = 0.3) {
    let s = seed;
    return () => {
      s = (s * 1103515245 + 12345) % 2 ** 31;
      return s / 2 ** 31 < rate ? { status: 429 } : undefined;
    };
  }

  it("20 simultaneous job adds by three members: every job and activity row exactly once", async () => {
    h.chaos = quotaChaos(7);
    const who = ["anni", "lukky", "rishii"] as const;
    const jobs = await Promise.all(Array.from({ length: 20 }, (_, i) => createJob(who[i % 3], input(i), T0)));
    expect(rows("Jobs")).toHaveLength(20);
    expect(unique(rows("Jobs").map((r) => r[0]))).toBe(true);
    expect(unique(rows("Jobs").map((r) => r[8]))).toBe(true);
    expect(rows("Jobs").map((r) => r[0]).sort()).toEqual(jobs.map((j) => j.jobId).sort());
    expect(rows("Activity").filter((r) => r[3] === "job_added")).toHaveLength(20);
    expect(unique(rows("Activity").map((r) => r[0]))).toBe(true);
  });

  it("the same link submitted 5 times at once is stored once (duplicate check still holds)", async () => {
    h.chaos = quotaChaos(11);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => createJob("anni", input(1), T0)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason.code === "duplicate_url")).toBe(true);
    expect(rows("Jobs")).toHaveLength(1);
  });

  it("all members updating applications, answering, chatting and loading pages at once stays consistent", async () => {
    const job = await createJob("anni", input(1), T0);
    h.chaos = quotaChaos(23);
    const members = ["anni", "lukky", "rishii"] as const;
    await Promise.all([
      ...members.map((m) => setApplicationStatus(m, job.jobId, { status: "Applied" }, T0)),
      ...members.map((m) => setApplicationStatus(m, job.jobId, { status: "Applied" }, T0)), // double click
      ...members.map((m, i) => sendTextMessage(m, `msg ${i}`, T0)),
      ...members.map((m) => getDashboardData(m, T0)),
      ...members.map((m) => recordVisit(m, T0)),
    ]);
    const apps = rows("Applications").filter((r) => r[0] === job.jobId);
    expect(apps.map((r) => r[1]).sort()).toEqual(["anni", "lukky", "rishii"]);
    expect(rows("ChatMessages")).toHaveLength(3);
    expect(unique(rows("ChatMessages").map((r) => r[0]))).toBe(true);
    expect(rows("Activity").filter((r) => r[3] === "visit")).toHaveLength(3);
    expect(rows("Activity").filter((r) => r[3] === "job_applied")).toHaveLength(3);
  });

  it("repeated page loads by every member never surface an error while quota errors are intermittent", async () => {
    h.chaos = quotaChaos(5, 0.4);
    for (let round = 0; round < 15; round++) {
      await Promise.all((["anni", "lukky", "rishii"] as const).map((m) => getDashboardData(m, T0)));
    }
    expect(sleeps.length).toBeGreaterThan(0); // failures really happened, and every load recovered
  });
});
