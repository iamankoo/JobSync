import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { POST as postJob } from "@/app/api/jobs/route";
import { PUT as putApp } from "@/app/api/applications/[jobId]/route";
import { GET as getConfig } from "@/app/api/push/config/route";
import { DELETE as deleteSub, POST as postSub } from "@/app/api/push/subscriptions/route";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { setPushSenderForTesting, resetPushDedupeForTesting, type PushSender } from "@/lib/push/notify";
import { MAX_DEVICES_PER_MEMBER, subscriptionIdFor } from "@/lib/google-sheets/push-service";
import type { MemberId } from "@/config/members";
import { FakeSheets, googleError } from "../helpers/fake-sheets";

const MEMBERS: MemberId[] = ["anni", "lukky", "rishii"];
const NAME: Record<MemberId, string> = { anni: "Anni", lukky: "Lukky", rishii: "Rishii" };

let sheets: FakeSheets;
let sent: { member: MemberId; endpoint: string; payload: { title: string; body: string; url: string; tag: string } }[];
let sender: ReturnType<typeof vi.fn<PushSender>>;

const as = (m: MemberId | null) => vi.mocked(getSession).mockResolvedValue(m ? { memberId: m, expiresAt: 9_999_999_999 } : null);
const req = (url: string, method: string, data?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", host: "localhost", ...headers },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
const endpointOf = (m: MemberId, n = 1) => `https://fcm.googleapis.com/fcm/send/${m}-device-${n}`;
const subBody = (m: MemberId, n = 1, keys = { p256dh: "BPk1234567890abcd", auth: "auth1234567890" }) => ({ endpoint: endpointOf(m, n), keys });
const jobBody = (over: Record<string, unknown> = {}) => ({
  company: "Acme Corp", jobRole: "Software Engineer", jobType: "Full-time", location: "Testville", experience: "0–1 years",
  jobUrl: "https://jobs.example.test/1", ...over,
});

async function subscribe(m: MemberId, n = 1) {
  as(m);
  const res = await postSub(req("/api/push/subscriptions", "POST", subBody(m, n)));
  expect(res.status).toBeLessThan(300);
}
async function subscribeAll() {
  for (const m of MEMBERS) await subscribe(m);
}
const addJob = async (m: MemberId, over: Record<string, unknown> = {}) => {
  as(m);
  return postJob(req("/api/jobs", "POST", jobBody(over)));
};
const apply = async (m: MemberId, jobId: string, status = "Applied") => {
  as(m);
  return putApp(req(`/api/applications/${jobId}`, "PUT", { status }), { params: Promise.resolve({ jobId }) });
};
const recipients = () => sent.map((s) => s.member).sort();

beforeEach(() => {
  vi.stubEnv("VAPID_PUBLIC_KEY", "test-public-key");
  vi.stubEnv("VAPID_PRIVATE_KEY", "test-private-key");
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
  resetPushDedupeForTesting();
  sent = [];
  sender = vi.fn<PushSender>(async (sub, payload) => {
    sent.push({ member: sub.memberId, endpoint: sub.endpoint, payload });
    return { ok: true };
  });
  setPushSenderForTesting(sender);
});
afterEach(() => {
  setSheetsClientForTesting(null);
  setPushSenderForTesting(null);
  vi.mocked(getSession).mockReset();
  vi.unstubAllEnvs();
});

describe("job added notifications", () => {
  for (const actor of MEMBERS) {
    it(`${NAME[actor]} adds a job: only the other two members are notified`, async () => {
      await subscribeAll();
      const res = await addJob(actor);
      expect(res.status).toBe(201);
      expect(recipients()).toEqual(MEMBERS.filter((m) => m !== actor).sort());
      expect(sent.some((s) => s.member === actor)).toBe(false);
      for (const s of sent) {
        expect(s.payload.title).toBe(`${NAME[actor]} added a job: Software Engineer`);
        expect(s.payload.body).toContain("Acme Corp");
      }
    });
  }

  it("links the notification to the new job", async () => {
    await subscribeAll();
    const { data } = await (await addJob("anni")).json();
    expect(sent[0].payload.url).toBe(`/all-jobs?job=${data.jobId}`);
  });

  it("notifies every device of the other members", async () => {
    await subscribeAll();
    await subscribe("lukky", 2);
    await addJob("anni");
    expect(sent.filter((s) => s.member === "lukky")).toHaveLength(2);
    expect(sent.filter((s) => s.member === "rishii")).toHaveLength(1);
  });

  it("sends nothing when the Sheets write fails", async () => {
    await subscribeAll();
    sheets.failNext = { op: "append", error: googleError(500) };
    const res = await addJob("anni");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(sheets.dataRows("Jobs")).toHaveLength(0);
    expect(sender).not.toHaveBeenCalled();
  });

  it("sends nothing for a validation error", async () => {
    await subscribeAll();
    const res = await addJob("anni", { jobUrl: "not a url" });
    expect(res.status).toBe(400);
    expect(sender).not.toHaveBeenCalled();
  });

  it("does not notify again for a retried/duplicate submission", async () => {
    await subscribeAll();
    expect((await addJob("anni")).status).toBe(201);
    expect((await addJob("anni")).status).toBe(409);
    expect((await addJob("lukky")).status).toBe(409);
    expect(sender).toHaveBeenCalledTimes(2); // exactly Lukky + Rishii, once
  });

  it("keeps the job saved when push delivery fails or throws", async () => {
    await subscribeAll();
    sender.mockRejectedValue(new Error("push service down"));
    const res = await addJob("anni");
    expect(res.status).toBe(201);
    expect(sheets.dataRows("Jobs")).toHaveLength(1);
    expect(sheets.dataRows("Applications")).toHaveLength(0);
  });

  it("keeps the job saved when the push subscriptions tab cannot be read", async () => {
    await subscribeAll();
    sheets.tabs.delete("PushSubscriptions");
    const res = await addJob("anni");
    expect(res.status).toBe(201);
    expect(sheets.dataRows("Jobs")).toHaveLength(1);
    expect(sender).not.toHaveBeenCalled();
  });

  it("does nothing (and still saves) when VAPID is not configured", async () => {
    await subscribeAll();
    vi.stubEnv("VAPID_PRIVATE_KEY", "");
    expect((await addJob("anni")).status).toBe(201);
    expect(sender).not.toHaveBeenCalled();
  });
});

describe("applied notifications", () => {
  for (const actor of MEMBERS) {
    it(`${NAME[actor]} marks a job Applied: only the other two are notified`, async () => {
      await subscribeAll();
      const { data } = await (await addJob("anni", { jobRole: "Backend Developer" })).json();
      sent.length = 0;
      sender.mockClear();
      expect((await apply(actor, data.jobId)).status).toBe(200);
      expect(recipients()).toEqual(MEMBERS.filter((m) => m !== actor).sort());
      for (const s of sent) {
        expect(s.payload.title).toBe(`${NAME[actor]} applied for Backend Developer — hurry up!`);
        expect(s.payload.body).toContain("Acme Corp");
        expect(s.payload.url).toBe(`/all-jobs?job=${data.jobId}`);
      }
    });
  }

  async function newJob() {
    await subscribeAll();
    const { data } = await (await addJob("anni")).json();
    sent.length = 0;
    sender.mockClear();
    return data.jobId as string;
  }

  async function newJobWithUrl(jobUrl: string) {
    const { data } = await (await addJob("anni", { jobUrl })).json();
    return data.jobId as string;
  }

  it("does not notify on a repeated Applied request", async () => {
    const id = await newJob();
    await apply("lukky", id);
    await apply("lukky", id);
    await apply("lukky", id);
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it("does not notify for other status changes or un-applying", async () => {
    const id = await newJob();
    await apply("lukky", id);
    sender.mockClear();
    expect((await apply("lukky", id, "Interview")).status).toBe(200);
    expect((await apply("lukky", id, "Offer")).status).toBe(200);
    expect(sender).not.toHaveBeenCalled();
    const other = await newJobWithUrl("https://jobs.example.test/2");
    await apply("rishii", other);
    sender.mockClear();
    expect((await apply("rishii", other, "Not Applied")).status).toBe(200);
    expect(sender).not.toHaveBeenCalled();
  });

  it("does not notify when the status change is rejected or the job does not exist", async () => {
    const id = await newJob();
    expect((await apply("lukky", id, "Offer")).status).toBe(409); // Not Applied -> Offer is invalid
    expect((await apply("lukky", "job_missing")).status).toBe(404);
    expect(sender).not.toHaveBeenCalled();
  });

  it("does not notify when the Sheets write fails", async () => {
    const id = await newJob();
    sheets.failNext = { op: "append", error: googleError(500) };
    expect((await apply("lukky", id)).status).toBeGreaterThanOrEqual(400);
    expect(sheets.dataRows("Applications")).toHaveLength(0);
    expect(sender).not.toHaveBeenCalled();
  });

  it("keeps the application saved when delivery fails", async () => {
    const id = await newJob();
    sender.mockRejectedValue(new Error("boom"));
    const res = await apply("lukky", id);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ status: "Applied", changed: true });
    expect(sheets.dataRows("Applications")[0][2]).toBe("Applied");
  });

  it("notifies again for a genuinely new apply after un-applying", async () => {
    const id = await newJob();
    await apply("lukky", id);
    await apply("lukky", id, "Not Applied");
    sender.mockClear();
    await new Promise((r) => setTimeout(r, 5)); // distinct AppliedAt
    await apply("lukky", id);
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it("does not change the API response shape", async () => {
    const id = await newJob();
    const body = await (await apply("lukky", id)).json();
    expect(Object.keys(body.data).sort()).toEqual(["application", "changed", "jobId", "status"]);
  });
});

describe("invalid and expired subscriptions", () => {
  it("removes subscriptions the push service reports as gone (404/410) and keeps the rest", async () => {
    await subscribeAll();
    await subscribe("lukky", 2);
    sender.mockImplementation(async (sub) => (sub.endpoint === endpointOf("lukky", 1) ? { ok: false, gone: true, status: 410 } : { ok: true }));
    expect((await addJob("anni")).status).toBe(201);
    const remaining = sheets.dataRows("PushSubscriptions").map((r) => r[2]);
    expect(remaining).not.toContain(endpointOf("lukky", 1));
    expect(remaining).toContain(endpointOf("lukky", 2));
    expect(remaining).toContain(endpointOf("rishii", 1));
  });

  it("keeps subscriptions after a temporary failure", async () => {
    await subscribeAll();
    sender.mockResolvedValue({ ok: false, gone: false, status: 503 });
    await addJob("anni");
    expect(sheets.dataRows("PushSubscriptions")).toHaveLength(3);
  });

  it("never logs endpoints, keys or payloads", async () => {
    await subscribeAll();
    const spies = [vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "log")].map((s) => s.mockImplementation(() => undefined));
    sender.mockResolvedValue({ ok: false, gone: true, status: 410 });
    await addJob("anni");
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged).not.toContain("fcm.googleapis.com");
    expect(logged).not.toContain("BPk1234567890abcd");
    expect(logged).not.toContain("test-private-key");
    spies.forEach((s) => s.mockRestore());
  });
});

describe("subscription endpoints", () => {
  it("require a session", async () => {
    as(null);
    expect((await postSub(req("/api/push/subscriptions", "POST", subBody("anni")))).status).toBe(401);
    expect((await deleteSub(req("/api/push/subscriptions", "DELETE", { endpoint: endpointOf("anni") }))).status).toBe(401);
    expect((await getConfig(req("/api/push/config", "GET"))).status).toBe(401);
    expect(sheets.dataRows("PushSubscriptions")).toHaveLength(0);
  });

  it("rejects cross-origin writes", async () => {
    as("anni");
    const res = await postSub(req("/api/push/subscriptions", "POST", subBody("anni"), { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
  });

  it("stores the subscription under the SESSION member, never a client-supplied one", async () => {
    as("anni");
    const res = await postSub(req("/api/push/subscriptions", "POST", { ...subBody("anni"), memberId: "lukky" }));
    expect(res.status).toBe(400); // strict body: memberId is rejected
    const ok = await postSub(req("/api/push/subscriptions", "POST", subBody("anni")));
    expect(ok.status).toBe(201);
    expect(sheets.dataRows("PushSubscriptions")[0][1]).toBe("anni");
  });

  it("is idempotent for the same device", async () => {
    await subscribe("anni");
    await subscribe("anni");
    expect(sheets.dataRows("PushSubscriptions")).toHaveLength(1);
  });

  it("rejects endpoints that are not browser push services (no server-side request forgery)", async () => {
    as("anni");
    for (const endpoint of ["https://evil.example/collect", "http://fcm.googleapis.com/x", "https://localhost/x", "https://fcm.googleapis.com.evil.example/x", "https://169.254.169.254/latest", "javascript:alert(1)"]) {
      const res = await postSub(req("/api/push/subscriptions", "POST", { endpoint, keys: subBody("anni").keys }));
      expect(res.status, endpoint).toBe(400);
    }
    expect(sheets.dataRows("PushSubscriptions")).toHaveLength(0);
  });

  it("does not let a member take over or delete another member's subscription", async () => {
    await subscribe("anni");
    // Lukky tries to claim Anni's endpoint with different keys.
    as("lukky");
    const takeover = await postSub(req("/api/push/subscriptions", "POST", subBody("anni", 1, { p256dh: "OtherKey1234567890", auth: "otherAuth123456" })));
    expect(takeover.status).toBe(409);
    // Lukky tries to remove it.
    const del = await deleteSub(req("/api/push/subscriptions", "DELETE", { endpoint: endpointOf("anni") }));
    expect((await del.json()).data.removed).toBe(false);
    expect(sheets.dataRows("PushSubscriptions")).toHaveLength(1);
    expect(sheets.dataRows("PushSubscriptions")[0][1]).toBe("anni");
  });

  it("moves a device to the new member when the same browser signs in as someone else", async () => {
    await subscribe("anni");
    as("lukky");
    expect((await postSub(req("/api/push/subscriptions", "POST", subBody("anni")))).status).toBe(200);
    expect(sheets.dataRows("PushSubscriptions")[0][1]).toBe("lukky");
  });

  it("removes only the caller's own device on DELETE (other devices keep working)", async () => {
    await subscribe("anni", 1);
    await subscribe("anni", 2);
    as("anni");
    const res = await deleteSub(req("/api/push/subscriptions", "DELETE", { endpoint: endpointOf("anni", 1) }));
    expect((await res.json()).data.removed).toBe(true);
    expect(sheets.dataRows("PushSubscriptions").map((r) => r[0])).toEqual([subscriptionIdFor(endpointOf("anni", 2))]);
  });

  it("bounds the number of devices per member", async () => {
    for (let n = 1; n <= MAX_DEVICES_PER_MEMBER + 3; n++) await subscribe("anni", n);
    expect(sheets.dataRows("PushSubscriptions")).toHaveLength(MAX_DEVICES_PER_MEMBER);
  });

  it("serves only the PUBLIC key from /api/push/config and reports 503 when unconfigured", async () => {
    as("anni");
    const res = await getConfig(req("/api/push/config", "GET"));
    const text = await res.text();
    expect(JSON.parse(text).data.publicKey).toBe("test-public-key");
    expect(text).not.toContain("test-private-key");
    vi.stubEnv("VAPID_PUBLIC_KEY", "");
    expect((await getConfig(req("/api/push/config", "GET"))).status).toBe(503);
  });

  it("/api/push/config also reports 503 until the PushSubscriptions tab exists", async () => {
    as("anni");
    sheets.tabs.delete("PushSubscriptions");
    const res = await getConfig(req("/api/push/config", "GET"));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("push_not_configured");
  });

  it("reports 503 (not a crash) when the PushSubscriptions tab does not exist yet", async () => {
    sheets.tabs.delete("PushSubscriptions");
    as("anni");
    const res = await postSub(req("/api/push/subscriptions", "POST", subBody("anni")));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("push_not_configured");
  });
});
