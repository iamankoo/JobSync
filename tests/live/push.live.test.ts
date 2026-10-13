import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { requireSafeTestEnv } from "../helpers/live-env";
import { openTestSheet, snapshotProduction } from "../helpers/live-sheets";

/**
 * LIVE integration tests for push notifications: real services against the REAL Google Sheets API, pointed at the
 * DISPOSABLE test spreadsheet only. Delivery to push services is MOCKED (no real device is contacted here).
 */
const MARK = "[LIVE TEST]";
let sheet: ReturnType<typeof openTestSheet>;
let before: Awaited<ReturnType<typeof snapshotProduction>>;
const log = (label: string, value: unknown) => console.log(`LIVE ${label}: ${JSON.stringify(value)}`);

type Mods = {
  jobs: typeof import("@/lib/google-sheets/jobs-service");
  apps: typeof import("@/lib/google-sheets/applications-service");
  push: typeof import("@/lib/google-sheets/push-service");
  notify: typeof import("@/lib/push/notify");
  daily: typeof import("@/lib/push/daily-run");
  status: typeof import("@/lib/google-sheets/status-service");
  members: typeof import("@/lib/google-sheets/members-service");
};
let m: Mods;
const delivered: { member: string; title: string; body: string }[] = [];
const keys = { p256dh: "BPk1234567890abcd", auth: "auth1234567890" };
const ep = (who: string) => `https://fcm.googleapis.com/fcm/send/live-test-${who}`;

beforeAll(async () => {
  const safe = requireSafeTestEnv();
  process.env.GOOGLE_SHEETS_SPREADSHEET_ID = safe.testId;
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = safe.email;
  process.env.GOOGLE_PRIVATE_KEY = safe.privateKey;
  process.env.SHEETS_CACHE_TTL_MS = "0";
  process.env.VAPID_PUBLIC_KEY = "live-test-public";
  process.env.VAPID_PRIVATE_KEY = "live-test-private";
  process.env.APP_TIMEZONE = "Asia/Kolkata";
  delete process.env.SHEETS_TEST_BACKEND;

  sheet = openTestSheet();
  expect(await sheet.title()).toMatch(/^JobSync TEST/);
  before = await snapshotProduction();
  await sheet.reset();

  m = {
    jobs: await import("@/lib/google-sheets/jobs-service"),
    apps: await import("@/lib/google-sheets/applications-service"),
    push: await import("@/lib/google-sheets/push-service"),
    notify: await import("@/lib/push/notify"),
    daily: await import("@/lib/push/daily-run"),
    status: await import("@/lib/google-sheets/status-service"),
    members: await import("@/lib/google-sheets/members-service"),
  };
  m.members.resetMembersCache();
  m.notify.setPushSenderForTesting(async (sub, payload) => {
    delivered.push({ member: sub.memberId, title: payload.title, body: payload.body });
    return { ok: true };
  });
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 6_000)); // stay under Google's per-minute read quota
});

afterAll(async () => {
  m?.notify.setPushSenderForTesting(null);
  if (!sheet) return;
  await sheet.reset();
  const leftover = (await sheet.dataRows("PushSubscriptions")).length + (await sheet.dataRows("NotificationLog")).length + (await sheet.dataRows("Jobs")).length;
  expect(leftover).toBe(0);
  const after = await snapshotProduction();
  log("production snapshot before", before);
  log("production snapshot after", after);
  expect(after).toEqual(before);
});

describe("push notifications against the real Google Sheets API (test spreadsheet)", () => {
  it("status check passes with the two optional tabs present", async () => {
    const res = await m.status.checkSheetsStatus();
    expect(res.ok).toBe(true);
    expect(res.tabs.find((t) => t.tab === "PushSubscriptions")?.ok).toBe(true);
    expect(res.tabs.find((t) => t.tab === "NotificationLog")?.ok).toBe(true);
  });

  it("persists subscriptions per member and is idempotent", async () => {
    for (const who of ["anni", "lukky", "rishii"] as const) await m.push.saveSubscription(who, { endpoint: ep(who), keys });
    await m.push.saveSubscription("anni", { endpoint: ep("anni"), keys });
    const rows = await sheet.dataRows("PushSubscriptions");
    log("subscription rows (secrets omitted)", rows.map((r) => [r[0], r[1]]));
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r[1]).sort()).toEqual(["anni", "lukky", "rishii"]);
  });

  it("job added: persisted first, then only the other two members are notified", async () => {
    delivered.length = 0;
    const job = await m.jobs.createJob("lukky", {
      company: `${MARK} Co`, jobRole: `${MARK} Role`, jobType: "Full-time", experience: "Fresher", location: "Hybrid", jobUrl: "https://example.test/live-push-1",
    });
    expect((await sheet.dataRows("Jobs")).some((r) => r[0] === job.jobId)).toBe(true);
    expect(delivered.map((d) => d.member).sort()).toEqual(["anni", "rishii"]);
    expect(delivered[0].title).toBe(`Lukky added a job: ${MARK} Role`);
    await expect(
      m.jobs.createJob("lukky", { company: "x", jobRole: "x", jobType: "Full-time", experience: "Fresher", location: "Hybrid", jobUrl: "https://example.test/live-push-1" }),
    ).rejects.toMatchObject({ code: "duplicate_url" });
    expect(delivered).toHaveLength(2); // the rejected retry notified nobody

    delivered.length = 0;
    await m.apps.setApplicationStatus("anni", job.jobId, { status: "Applied" });
    await m.apps.setApplicationStatus("anni", job.jobId, { status: "Applied" });
    expect(delivered.map((d) => d.member).sort()).toEqual(["lukky", "rishii"]);
    expect(delivered[0].title).toBe(`Anni applied for ${MARK} Role — hurry up!`);
  });

  it("scheduled morning run: three members once, and concurrent duplicate invocations do not double-send (real Sheets)", async () => {
    delivered.length = 0;
    const at = new Date("2026-10-13T04:30:00Z");
    const pause = async () => undefined;
    await Promise.all([m.daily.runDailyNotifications("morning", at, pause), m.daily.runDailyNotifications("morning", at, pause), m.daily.runDailyNotifications("morning", at, pause)]);
    await m.daily.runDailyNotifications("morning", at, pause);
    const ledger = await sheet.dataRows("NotificationLog");
    log("ledger", ledger.map((r) => [r[0], r[5], r[8]]));
    expect(delivered.map((d) => d.member).sort()).toEqual(["anni", "lukky", "rishii"]);
    expect(ledger.filter((r) => r[5] === "sent")).toHaveLength(3);
  });

  it("scheduled night run counts real persisted jobs per member", async () => {
    delivered.length = 0;
    const day = "2026-10-13";
    const row = (id: string, by: string, at: string) => [id, "Co", "Role", "Full-time", "", "", "", "Loc", `https://example.test/${id}`, "", "", by, at];
    await sheet.appendRaw("Jobs", row("job_live_n1", "rishii", `${day}T07:00:00.000Z`));
    await sheet.appendRaw("Jobs", row("job_live_n2", "rishii", `${day}T08:00:00.000Z`));
    await sheet.appendRaw("Jobs", row("job_live_n3", "rishii", "2026-10-12T18:29:59.000Z"));
    await m.daily.runDailyNotifications("night", new Date("2026-10-13T16:30:00Z"), async () => undefined);
    const body = (who: string) => delivered.find((d) => d.member === who)?.body;
    log("night bodies", { anni: body("anni"), lukky: body("lukky"), rishii: body("rishii") });
    expect(body("rishii")).toBe("You added 2 out of 10 jobs today. Need more efforts, Rishii.");
    expect(body("anni")).toBe("You added 0 out of 10 jobs today. Need more efforts, Anni.");
  });

  it("removes only the callers own device", async () => {
    expect((await m.push.removeSubscription("lukky", ep("anni"))).removed).toBe(false);
    expect((await m.push.removeSubscription("anni", ep("anni"))).removed).toBe(true);
    expect((await sheet.dataRows("PushSubscriptions")).map((r) => r[1]).sort()).toEqual(["lukky", "rishii"]);
  });
});
