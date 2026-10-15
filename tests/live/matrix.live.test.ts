import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { requireSafeTestEnv } from "../helpers/live-env";
import { openTestSheet, snapshotProduction } from "../helpers/live-sheets";

/**
 * LIVE tests (real Google Sheets API, DISPOSABLE test spreadsheet only) for:
 *   - the complete notification recipient matrix for all three members (add job / apply), including one browser
 *     shared by all three members,
 *   - Connections, Group Chat messages, attachments (real 40 000-character cell chunks), unread and call signalling.
 * Push DELIVERY to real devices is replaced by a recorder; everything else is the real code on the real Sheets API.
 * All data is marked "[LIVE TEST]" and the sheet is cleared afterwards; production is snapshotted before and after.
 */
const MARK = "[LIVE TEST]";
const MEMBERS = ["anni", "lukky", "rishii"] as const;
type M = (typeof MEMBERS)[number];
const NAME: Record<M, string> = { anni: "Anni", lukky: "Lukky", rishii: "Rishii" };
let sheet: ReturnType<typeof openTestSheet>;
let before: Awaited<ReturnType<typeof snapshotProduction>>;
const log = (label: string, value: unknown) => console.log(`LIVE ${label}: ${JSON.stringify(value)}`);

let jobs: typeof import("@/lib/google-sheets/jobs-service");
let apps: typeof import("@/lib/google-sheets/applications-service");
let push: typeof import("@/lib/google-sheets/push-service");
let notify: typeof import("@/lib/push/notify");
let daily: typeof import("@/lib/push/daily-run");
let conns: typeof import("@/lib/google-sheets/connections-service");
let chat: typeof import("@/lib/google-sheets/chat-service");
let files: typeof import("@/lib/google-sheets/chat-files-service");
let calls: typeof import("@/lib/google-sheets/call-service");
let members: typeof import("@/lib/google-sheets/members-service");

const delivered: { member: M; endpoint: string; title: string; body: string }[] = [];
const keys = { p256dh: "BPk1234567890abcd", auth: "auth1234567890" };
const ep = (who: string) => `https://fcm.googleapis.com/fcm/send/live-matrix-${who}`;
let urlCounter = 0;
const job = (role: string) => ({ company: `${MARK} Co`, jobRole: role, jobType: "Full-time" as const, experience: "Fresher", location: "Hybrid", jobUrl: `https://example.test/live-matrix-${Date.now()}-${urlCounter++}` });

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

  jobs = await import("@/lib/google-sheets/jobs-service");
  apps = await import("@/lib/google-sheets/applications-service");
  push = await import("@/lib/google-sheets/push-service");
  notify = await import("@/lib/push/notify");
  daily = await import("@/lib/push/daily-run");
  conns = await import("@/lib/google-sheets/connections-service");
  chat = await import("@/lib/google-sheets/chat-service");
  files = await import("@/lib/google-sheets/chat-files-service");
  calls = await import("@/lib/google-sheets/call-service");
  members = await import("@/lib/google-sheets/members-service");
  members.resetMembersCache();
  notify.setPushSenderForTesting(async (sub, payload) => {
    delivered.push({ member: sub.memberId, endpoint: sub.endpoint, title: payload.title, body: payload.body });
    return { ok: true };
  });
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 6_000)); // stay under Google's per-minute read quota
});

afterAll(async () => {
  notify?.setPushSenderForTesting(null);
  if (!sheet) return;
  await sheet.reset();
  let leftover = 0;
  for (const tab of ["Jobs", "Applications", "Activity", "PushSubscriptions", "NotificationLog", "Connections", "ChatMessages", "ChatFiles", "ChatReads", "CallSignals"] as const) {
    leftover += (await sheet.dataRows(tab)).length;
  }
  expect(leftover).toBe(0);
  const after = await snapshotProduction();
  log("production snapshot before", before);
  log("production snapshot after", after);
  expect(after).toEqual(before);
});

describe("notification recipient matrix on the real Sheets API (every actor, add and apply)", () => {
  it("each member has their own device registered", async () => {
    for (const who of MEMBERS) await push.saveSubscription(who, { endpoint: ep(who), keys });
    const rows = await sheet.dataRows("PushSubscriptions");
    expect(rows.map((r) => r[1]).sort()).toEqual(["anni", "lukky", "rishii"]);
  });

  for (const actor of MEMBERS) {
    it(`${NAME[actor]} adds a job and applies: the other two are notified, ${NAME[actor]} is not`, async () => {
      const others = MEMBERS.filter((m) => m !== actor);
      delivered.length = 0;
      const created = await jobs.createJob(actor, job(`${MARK} ${NAME[actor]} role`));
      expect((await sheet.dataRows("Jobs")).some((r) => r[0] === created.jobId && r[11] === actor)).toBe(true);
      log(`${actor} added -> recipients`, delivered.map((d) => [d.member, d.title]));
      expect(delivered.map((d) => d.member).sort()).toEqual([...others].sort());
      expect(delivered.some((d) => d.member === actor)).toBe(false);
      for (const d of delivered) expect(d.title).toBe(`${NAME[actor]} added a job: ${MARK} ${NAME[actor]} role`);

      delivered.length = 0;
      await apps.setApplicationStatus(actor, created.jobId, { status: "Applied" });
      log(`${actor} applied -> recipients`, delivered.map((d) => [d.member, d.title]));
      expect(delivered.map((d) => d.member).sort()).toEqual([...others].sort());
      expect(delivered.some((d) => d.member === actor)).toBe(false);
      for (const d of delivered) expect(d.title).toBe(`${NAME[actor]} applied for ${MARK} ${NAME[actor]} role — hurry up!`);
    });
  }

  it("ONE browser used by all three members: everyone stays registered, and each action still reaches the other two", async () => {
    // wipe the per-member devices and register the SAME browser (same endpoint + keys) as each member in turn
    await sheet.reset();
    const shared = ep("shared-browser");
    for (const who of MEMBERS) await push.saveSubscription(who, { endpoint: shared, keys });
    const rows = await sheet.dataRows("PushSubscriptions");
    log("shared browser rows", rows.map((r) => [r[0].slice(0, 8), r[1]]));
    expect(rows.map((r) => r[1]).sort()).toEqual(["anni", "lukky", "rishii"]); // nobody lost the browser
    for (const actor of MEMBERS) {
      delivered.length = 0;
      await jobs.createJob(actor, job(`${MARK} shared ${actor}`));
      expect(delivered.length).toBe(1); // one device, one message, never the actor's own registration
      expect(delivered[0].title).toBe(`${NAME[actor]} added a job: ${MARK} shared ${actor}`);
      expect(delivered[0].member).not.toBe(actor);
    }
  });

  it("the scheduled 10 AM message is personal to each member, even on a browser shared by all three", async () => {
    delivered.length = 0;
    await daily.runDailyNotifications("morning", new Date("2026-10-14T04:30:00Z"), async () => undefined);
    log("morning titles", delivered.map((d) => [d.member, d.title]));
    expect(delivered.map((d) => d.member).sort()).toEqual(["anni", "lukky", "rishii"]);
    for (const d of delivered) expect(d.title).toBe(`Good morning, ${NAME[d.member]}! ☀️`);
    // retried scheduler call: nothing is sent twice
    delivered.length = 0;
    const again = await daily.runDailyNotifications("morning", new Date("2026-10-14T04:31:00Z"), async () => undefined);
    expect(delivered).toHaveLength(0);
    expect(again.ran && again.results.every((r) => r.outcome === "already_sent")).toBe(true);
  });

  it("the scheduled 10 PM message counts each member's own real jobs (including zero)", async () => {
    await sheet.reset();
    for (const who of MEMBERS) await push.saveSubscription(who, { endpoint: ep(who), keys });
    const day = "2026-10-14";
    const row = (id: string, by: string, at: string) => [id, "Co", "Role", "Full-time", "", "", "", "Loc", `https://example.test/${id}`, "", "", by, at];
    const plan: Record<M, number> = { anni: 7, lukky: 0, rishii: 10 };
    let n = 0;
    for (const who of MEMBERS) for (let i = 0; i < plan[who]; i++) await sheet.appendRaw("Jobs", row(`job_live_m${n++}`, who, `${day}T${String(4 + i).padStart(2, "0")}:15:00.000Z`));
    delivered.length = 0;
    await daily.runDailyNotifications("night", new Date("2026-10-14T16:35:00Z"), async () => undefined);
    const body = (w: M) => delivered.find((d) => d.member === w)?.body;
    log("night bodies", { anni: body("anni"), lukky: body("lukky"), rishii: body("rishii") });
    expect(body("anni")).toBe("You added 7 out of 10 jobs today. Nice going, let's finish the target, Anni.");
    expect(body("lukky")).toBe("You added 0 out of 10 jobs today. Need more efforts, Lukky.");
    expect(body("rishii")).toBe("You added 10 out of 10 jobs today. Today's target achieved! Good night, Rishii.");
  });
});

describe("Connections on the real Sheets API", () => {
  it("is one SHARED list: everyone sees every entry; only the adder edits or deletes", async () => {
    const a = await conns.createConnection("anni", { name: `${MARK} Priya`, company: "Acme", role: "EM", profileUrl: "https://www.linkedin.com/in/live-test", message: "Hi\nthere", status: "Not Connected" });
    await conns.createConnection("lukky", { name: `${MARK} Lukky's contact`, status: "Connected" });
    expect((await conns.listConnections()).map((c) => c.name).sort()).toEqual([`${MARK} Lukky's contact`, `${MARK} Priya`]);
    for (const status of ["Connected", "Messaged", "Reply"] as const) expect((await conns.updateConnection("anni", a.connectionId, { status })).status).toBe(status);
    const [row] = (await sheet.dataRows("Connections")).filter((r) => r[0] === a.connectionId);
    expect(row[9]).toBe("Reply");
    expect(row[7]).toBe("Hi\nthere");
    await expect(conns.updateConnection("lukky", a.connectionId, { status: "Reply" })).rejects.toMatchObject({ code: "not_connection_owner" });
    await expect(conns.deleteConnection("rishii", a.connectionId)).rejects.toMatchObject({ code: "not_connection_owner" });
    await conns.deleteConnection("anni", a.connectionId);
    expect((await conns.listConnections()).map((c) => c.memberId)).toEqual(["lukky"]);
  });
});

describe("Group chat on the real Sheets API", () => {
  it("messages persist and reach the other members; unread and read markers work", async () => {
    await chat.sendTextMessage("anni", `${MARK} hello`);
    await chat.sendTextMessage("lukky", `${MARK} hi back`);
    const page = await chat.listMessages("rishii", 0);
    expect(page.messages.map((m) => [m.memberId, m.text])).toEqual([["anni", `${MARK} hello`], ["lukky", `${MARK} hi back`]]);
    expect(await chat.countUnread("rishii")).toBe(2);
    expect(await chat.countUnread("anni")).toBe(1);
    await chat.markRead("rishii", page.cursor);
    expect(await chat.countUnread("rishii")).toBe(0);
    await chat.sendTextMessage("anni", `${MARK} again`);
    expect(await chat.countUnread("rishii")).toBe(1);
    const next = await chat.listMessages("rishii", page.cursor);
    expect(next.messages.map((m) => m.text)).toEqual([`${MARK} again`]);
  });

  it("a near-maximum (1.9 MB) attachment survives the 40 000-character cell chunks byte for byte", async () => {
    const bytes = new Uint8Array(1_900_000);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (let i = 8; i < bytes.length; i++) bytes[i] = (i * 131 + (i >> 8)) % 256;
    const fileId = await files.storeChatFile(bytes);
    const stored = (await sheet.dataRows("ChatFiles")).filter((r) => r[0] === fileId);
    log("chunks stored", { rows: stored.length, maxCell: Math.max(...stored.map((r) => r[2].length)) });
    expect(stored.length).toBe(files.chunkCountFor(bytes.length));
    expect(Math.max(...stored.map((r) => r[2].length))).toBeLessThanOrEqual(40_000);
    const back = await files.loadChatFile(fileId, bytes.length);
    expect(Buffer.from(bytes).equals(back)).toBe(true);
    await expect(files.loadChatFile("file_does_not_exist", 10)).rejects.toMatchObject({ code: "chat_file_not_found" });
  });

  it("call signalling: start, join, offer/answer addressed only to the target, leave, end", async () => {
    const started = await calls.applyCallAction("anni", { action: "start", media: "audio" });
    const callId = started.call!.callId;
    await calls.applyCallAction("lukky", { action: "join", callId });
    await calls.applyCallAction("anni", { action: "offer", callId, to: "lukky", payload: '{"type":"offer","sdp":"live"}' });
    const forLukky = await calls.getCallState("lukky", null, new Date(), { fresh: true });
    const forRishii = await calls.getCallState("rishii", null, new Date(), { fresh: true });
    expect(forLukky.signals.map((s) => s.type)).toContain("offer");
    expect(forRishii.signals.map((s) => s.type)).not.toContain("offer");
    expect(forRishii.active?.participants.sort()).toEqual(["anni", "lukky"]);
    await calls.applyCallAction("lukky", { action: "leave", callId });
    await calls.applyCallAction("anni", { action: "leave", callId });
    expect((await calls.getCallState("rishii", null, new Date(), { fresh: true })).active).toBeNull();
  });
});
