import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as cron } from "@/app/api/cron/daily-notifications/route";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { saveSubscription } from "@/lib/google-sheets/push-service";
import { serializeJob } from "@/lib/google-sheets/rows";
import { setPushSenderForTesting, type PushSender } from "@/lib/push/notify";
import { runDailyNotifications } from "@/lib/push/daily-run";
import { countJobsAddedOn, nightMessage, nightPayload, morningPayload, quoteFor, quoteIndexFor } from "@/lib/push/daily";
import { QUOTES } from "@/lib/push/quotes";
import { MEMBER_IDS, type MemberId } from "@/config/members";
import type { Job } from "@/types/domain";
import { makeJob } from "../helpers/fixtures";
import { FakeSheets, googleError } from "../helpers/fake-sheets";

const NAME: Record<MemberId, string> = { anni: "Anni", lukky: "Lukky", rishii: "Rishii" };
// 2026-10-13 in Asia/Kolkata (UTC+5:30, no DST)
const MORNING = new Date("2026-10-13T04:30:00Z"); // 10:00 IST
const NIGHT = new Date("2026-10-13T16:30:00Z"); // 22:00 IST
const DAY_START_Z = "2026-10-12T18:30:00.000Z"; // 00:00 IST on the 13th

let sheets: FakeSheets;
let sent: { member: MemberId; endpoint: string; title: string; body: string; url: string }[];
let sender: ReturnType<typeof vi.fn<PushSender>>;
const noPause = async () => undefined;

const endpointOf = (m: MemberId, n = 1) => `https://fcm.googleapis.com/fcm/send/${m}-${n}`;
const keys = { p256dh: "BPk1234567890abcd", auth: "auth1234567890" };
const subscribe = (m: MemberId, n = 1) => saveSubscription(m, { endpoint: endpointOf(m, n), keys });

function addJobs(member: MemberId, count: number, addedAt: string, startId = 1000, over: Partial<Job> = {}) {
  for (let i = 0; i < count; i++) {
    const job = makeJob(startId + i, { addedBy: member, addedAt, jobUrl: `https://jobs.example.test/${member}/${startId + i}`, ...over });
    sheets.rows("Jobs").push(serializeJob({ ...job, jobId: `job_${member}_${startId + i}` }));
  }
}
const ledger = () => sheets.dataRows("NotificationLog");
const sentRows = () => ledger().filter((r) => r[5] === "sent");
const to = (m: MemberId) => sent.filter((s) => s.member === m);

beforeEach(async () => {
  vi.stubEnv("VAPID_PUBLIC_KEY", "pub");
  vi.stubEnv("VAPID_PRIVATE_KEY", "priv");
  vi.stubEnv("APP_TIMEZONE", "Asia/Kolkata");
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
  sent = [];
  sender = vi.fn<PushSender>(async (sub, payload) => {
    sent.push({ member: sub.memberId, endpoint: sub.endpoint, title: payload.title, body: payload.body, url: payload.url });
    return { ok: true };
  });
  setPushSenderForTesting(sender);
  for (const m of MEMBER_IDS) await subscribe(m);
});
afterEach(() => {
  setSheetsClientForTesting(null);
  setPushSenderForTesting(null);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("night thresholds (exact, mutually exclusive)", () => {
  const cases: [number, string][] = [
    [0, "Need more efforts, Lukky."],
    [3, "Need more efforts, Lukky."],
    [4, "Good but still we can do better, Lukky."],
    [6, "Good but still we can do better, Lukky."],
    [7, "Nice going, let's finish the target, Lukky."],
    [9, "Nice going, let's finish the target, Lukky."],
    [10, "Today's target achieved! Good night, Lukky."],
    [14, "Today's target achieved! Good night, Lukky."],
  ];
  for (const [count, message] of cases) {
    it(`${count} jobs -> "${message}"`, () => {
      expect(nightMessage(count, "Lukky")).toBe(message);
      const p = nightPayload("lukky", "2026-10-13", count);
      expect(p.title).toBe("Hello, Lukky! 🌙");
      expect(p.body).toBe(`You added ${count} out of 10 jobs today. ${message}`);
    });
  }
  it("uses each recipient's own name", () => {
    for (const m of MEMBER_IDS) expect(nightMessage(0, NAME[m])).toBe(`Need more efforts, ${NAME[m]}.`);
  });
});

describe("counting jobs added today", () => {
  const TZ = "Asia/Kolkata";
  const j = (over: Partial<Job>) => makeJob(1, { addedBy: "anni", ...over });

  it("counts only the member's own jobs on the local date", () => {
    const jobs = [
      j({ jobId: "a1", addedAt: "2026-10-13T05:00:00.000Z" }),
      j({ jobId: "a2", addedAt: "2026-10-13T12:00:00.000Z" }),
      j({ jobId: "l1", addedAt: "2026-10-13T05:00:00.000Z", addedBy: "lukky" }),
      j({ jobId: "a3", addedAt: "2026-10-12T05:00:00.000Z" }),
    ];
    expect(countJobsAddedOn(jobs, "anni", "2026-10-13", TZ)).toBe(2);
    expect(countJobsAddedOn(jobs, "lukky", "2026-10-13", TZ)).toBe(1);
    expect(countJobsAddedOn(jobs, "rishii", "2026-10-13", TZ)).toBe(0);
  });

  it("handles local-midnight boundaries exactly (IST)", () => {
    const at = (iso: string, id: string) => j({ jobId: id, addedAt: iso });
    const jobs = [
      at("2026-10-12T18:29:59.000Z", "before"), // 23:59:59 IST on the 12th
      at("2026-10-12T18:30:00.000Z", "start"), // 00:00:00 IST on the 13th
      at("2026-10-13T18:29:59.000Z", "end"), // 23:59:59 IST on the 13th
      at("2026-10-13T18:30:00.000Z", "after"), // 00:00:00 IST on the 14th
    ];
    expect(countJobsAddedOn(jobs, "anni", "2026-10-13", TZ)).toBe(2);
    expect(countJobsAddedOn(jobs, "anni", "2026-10-12", TZ)).toBe(1);
    expect(countJobsAddedOn(jobs, "anni", "2026-10-14", TZ)).toBe(1);
  });

  it("uses the configured timezone, including daylight saving", () => {
    // 2026-03-08 is the US spring-forward day: local midnight is 05:00Z, the day is 23 h long.
    const jobs = [j({ jobId: "x", addedAt: "2026-03-08T04:59:59.000Z" }), j({ jobId: "y", addedAt: "2026-03-08T05:00:00.000Z" }), j({ jobId: "z", addedAt: "2026-03-09T03:59:59.000Z" }), j({ jobId: "w", addedAt: "2026-03-09T04:00:00.000Z" })];
    expect(countJobsAddedOn(jobs, "anni", "2026-03-08", "America/New_York")).toBe(2);
  });

  it("ignores invalid timestamps and counts a duplicated JobID once", () => {
    const jobs = [
      j({ jobId: "d", addedAt: "2026-10-13T05:00:00.000Z" }),
      j({ jobId: "d", addedAt: "2026-10-13T06:00:00.000Z" }),
      j({ jobId: "bad", addedAt: "not a date" }),
      j({ jobId: "empty", addedAt: "" }),
    ];
    expect(countJobsAddedOn(jobs, "anni", "2026-10-13", TZ)).toBe(1);
  });
});

describe("morning quotes", () => {
  it("has 100 distinct, short quotes", () => {
    expect(QUOTES).toHaveLength(100);
    expect(new Set(QUOTES).size).toBe(100);
    for (const q of QUOTES) expect(q.length).toBeLessThanOrEqual(80);
  });

  it("is deterministic per member and date, and never repeats on consecutive days", () => {
    for (const m of MEMBER_IDS) {
      let previous = -1;
      for (let d = 0; d < 120; d++) {
        const date = new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10);
        const idx = quoteIndexFor(m, date);
        expect(idx).toBe(quoteIndexFor(m, date));
        expect(idx).not.toBe(previous);
        previous = idx;
      }
    }
  });

  it("varies across days and members", () => {
    const days = Array.from({ length: 60 }, (_, d) => new Date(Date.UTC(2026, 9, 1 + d)).toISOString().slice(0, 10));
    expect(new Set(days.map((d) => quoteFor("anni", d))).size).toBeGreaterThan(40);
    expect(days.filter((d) => quoteFor("anni", d) !== quoteFor("lukky", d)).length).toBeGreaterThan(50);
  });

  it("builds a personalised, concise message with no counts", () => {
    const p = morningPayload("anni", "2026-10-13");
    expect(p.title).toBe("Good morning, Anni! ☀️");
    expect(p.body).toBe(`${quoteFor("anni", "2026-10-13")} Let's start applying and posting jobs!`);
    expect(p.body.length).toBeLessThanOrEqual(120);
    expect(p.body).not.toMatch(/\d/);
  });
});

describe("scheduled run: morning", () => {
  it("sends each member their own personalised notification, privately", async () => {
    const run = await runDailyNotifications("morning", MORNING, noPause);
    expect(run).toMatchObject({ ran: true, type: "morning", date: "2026-10-13", timeZone: "Asia/Kolkata" });
    for (const m of MEMBER_IDS) {
      expect(to(m)).toHaveLength(1);
      expect(to(m)[0].title).toBe(`Good morning, ${NAME[m]}! ☀️`);
      expect(to(m)[0].endpoint).toBe(endpointOf(m));
      expect(to(m)[0].url).toBe("/add-job");
    }
    expect(sentRows()).toHaveLength(3);
  });

  it("does not send again when the cron is invoked repeatedly", async () => {
    await runDailyNotifications("morning", MORNING, noPause);
    const again = await runDailyNotifications("morning", new Date(MORNING.getTime() + 60_000), noPause);
    await runDailyNotifications("morning", new Date(MORNING.getTime() + 120_000), noPause);
    expect(sender).toHaveBeenCalledTimes(3);
    expect(again.ran && again.results.every((r) => r.outcome === "already_sent")).toBe(true);
  });

  it("does not double-send when two invocations run at the same time", async () => {
    await Promise.all([runDailyNotifications("morning", MORNING, noPause), runDailyNotifications("morning", MORNING, noPause), runDailyNotifications("morning", MORNING, noPause)]);
    expect(sender).toHaveBeenCalledTimes(3);
    for (const m of MEMBER_IDS) expect(to(m)).toHaveLength(1);
    expect(sentRows()).toHaveLength(3);
  });

  it("sends again the next day (a new local date)", async () => {
    await runDailyNotifications("morning", MORNING, noPause);
    await runDailyNotifications("morning", new Date(MORNING.getTime() + 86_400_000), noPause);
    expect(sender).toHaveBeenCalledTimes(6);
  });
});

describe("scheduled run: night", () => {
  it("counts each member's own jobs today, including zero, and sends every member their own message", async () => {
    addJobs("anni", 3, "2026-10-13T06:00:00.000Z");
    addJobs("lukky", 6, "2026-10-13T07:00:00.000Z");
    addJobs("rishii", 10, "2026-10-13T08:00:00.000Z");
    addJobs("anni", 5, "2026-10-12T08:00:00.000Z", 2000); // yesterday: not counted
    const jobsBefore = JSON.stringify(sheets.rows("Jobs"));
    const appsBefore = JSON.stringify(sheets.rows("Applications"));
    const run = await runDailyNotifications("night", NIGHT, noPause);
    expect(run.ran && run.results.map((r) => r.outcome)).toEqual(["sent", "sent", "sent"]);
    expect(to("anni")[0].body).toBe("You added 3 out of 10 jobs today. Need more efforts, Anni.");
    expect(to("lukky")[0].body).toBe("You added 6 out of 10 jobs today. Good but still we can do better, Lukky.");
    expect(to("rishii")[0].body).toBe("You added 10 out of 10 jobs today. Today's target achieved! Good night, Rishii.");
    expect(sheets.rows("Jobs") && JSON.stringify(sheets.rows("Jobs"))).toBe(jobsBefore);
    expect(JSON.stringify(sheets.rows("Applications"))).toBe(appsBefore);
  });

  it("sends the 0-job message to a member who added nothing", async () => {
    addJobs("lukky", 4, "2026-10-13T07:00:00.000Z");
    await runDailyNotifications("night", NIGHT, noPause);
    expect(to("anni")[0].body).toBe("You added 0 out of 10 jobs today. Need more efforts, Anni.");
    expect(to("lukky")[0].body).toBe("You added 4 out of 10 jobs today. Good but still we can do better, Lukky.");
  });

  it("reaches the 7-9 band, and does not count other members' jobs, applications or invalid rows", async () => {
    addJobs("anni", 7, "2026-10-13T06:00:00.000Z");
    addJobs("lukky", 9, "2026-10-13T06:00:00.000Z", 3000);
    sheets.rows("Jobs").push(["job_bad", "Co", "Role", "Full-time", "", "", "", "Loc", "https://jobs.example.test/bad", "", "", "anni", "garbage"]);
    sheets.rows("Applications").push(["job_anni_1000", "anni", "Applied", "2026-10-13T06:00:00.000Z", "", "", "2026-10-13T06:00:00.000Z"]);
    await runDailyNotifications("night", NIGHT, noPause);
    expect(to("anni")[0].body).toContain("You added 7 out of 10 jobs today. Nice going, let's finish the target, Anni.");
    expect(to("lukky")[0].body).toContain("You added 9 out of 10");
  });

  it("counts using the local day around midnight", async () => {
    addJobs("anni", 1, "2026-10-12T18:29:59.000Z", 10); // 23:59:59 IST on the 12th: not today
    addJobs("anni", 1, "2026-10-12T18:30:00.000Z", 20); // 00:00:00 IST today
    addJobs("anni", 1, "2026-10-13T16:29:59.000Z", 30); // 21:59:59 IST today
    await runDailyNotifications("night", NIGHT, noPause);
    expect(to("anni")[0].body).toContain("You added 2 out of 10");
    expect(DAY_START_Z).toBe("2026-10-12T18:30:00.000Z");
  });

  it("is idempotent across repeated and concurrent invocations", async () => {
    addJobs("anni", 2, "2026-10-13T06:00:00.000Z");
    await Promise.all([runDailyNotifications("night", NIGHT, noPause), runDailyNotifications("night", NIGHT, noPause)]);
    await runDailyNotifications("night", NIGHT, noPause);
    expect(sender).toHaveBeenCalledTimes(3);
  });

  it("morning and night are independent slots on the same date", async () => {
    await runDailyNotifications("morning", MORNING, noPause);
    await runDailyNotifications("night", NIGHT, noPause);
    expect(sender).toHaveBeenCalledTimes(6);
    expect(ledger().map((r) => r[0]).sort()).toEqual(
      ["morning", "night"].flatMap((t) => MEMBER_IDS.map((m) => `${t}:${m}:2026-10-13`)).sort(),
    );
  });
});

describe("failure handling", () => {
  it("one member's temporary push failure does not stop the others, and a re-run retries only that member", async () => {
    sender.mockImplementation(async (sub, payload) => {
      if (sub.memberId === "lukky") return { ok: false, gone: false, status: 503 };
      sent.push({ member: sub.memberId, endpoint: sub.endpoint, title: payload.title, body: payload.body, url: payload.url });
      return { ok: true };
    });
    const first = await runDailyNotifications("morning", MORNING, noPause);
    expect(first.ran && first.results.map((r) => r.outcome)).toEqual(["sent", "delivery_failed", "sent"]);
    sender.mockImplementation(async (sub, payload) => {
      sent.push({ member: sub.memberId, endpoint: sub.endpoint, title: payload.title, body: payload.body, url: payload.url });
      return { ok: true };
    });
    const second = await runDailyNotifications("morning", new Date(MORNING.getTime() + 600_000), noPause);
    expect(second.ran && second.results.map((r) => r.outcome)).toEqual(["already_sent", "sent", "already_sent"]);
    expect(to("anni")).toHaveLength(1);
    expect(to("lukky")).toHaveLength(1);
    expect(to("rishii")).toHaveLength(1);
  });

  it("removes an expired subscription and still delivers to the member's other device", async () => {
    await subscribe("anni", 2);
    sender.mockImplementation(async (sub, payload) => {
      if (sub.endpoint === endpointOf("anni", 1)) return { ok: false, gone: true, status: 410 };
      sent.push({ member: sub.memberId, endpoint: sub.endpoint, title: payload.title, body: payload.body, url: payload.url });
      return { ok: true };
    });
    const run = await runDailyNotifications("morning", MORNING, noPause);
    expect(run.ran && run.results[0]).toMatchObject({ memberId: "anni", outcome: "sent", delivered: 1, devices: 2 });
    expect(sheets.dataRows("PushSubscriptions").map((r) => r[2])).not.toContain(endpointOf("anni", 1));
    expect(sheets.dataRows("PushSubscriptions").map((r) => r[2])).toContain(endpointOf("anni", 2));
  });

  it("a member whose only subscription expired is handled safely while the others are sent", async () => {
    sender.mockImplementation(async (sub, payload) => {
      if (sub.memberId === "rishii") return { ok: false, gone: true, status: 404 };
      sent.push({ member: sub.memberId, endpoint: sub.endpoint, title: payload.title, body: payload.body, url: payload.url });
      return { ok: true };
    });
    const run = await runDailyNotifications("morning", MORNING, noPause);
    expect(run.ran && run.results.map((r) => r.outcome)).toEqual(["sent", "sent", "delivery_failed"]);
    expect(sheets.dataRows("PushSubscriptions").map((r) => r[1])).not.toContain("rishii");
  });

  it("a member with no subscription does not block the others, and is retried once they subscribe", async () => {
    sheets.tabs.get("PushSubscriptions")!.splice(1); // nobody subscribed
    await subscribe("anni");
    await subscribe("rishii");
    const first = await runDailyNotifications("morning", MORNING, noPause);
    expect(first.ran && first.results.map((r) => r.outcome)).toEqual(["sent", "no_subscription", "sent"]);
    await subscribe("lukky");
    const retry = await runDailyNotifications("morning", new Date(MORNING.getTime() + 600_000), noPause);
    expect(retry.ran && retry.results.map((r) => r.outcome)).toEqual(["already_sent", "sent", "already_sent"]);
    expect(sender).toHaveBeenCalledTimes(3);
  });

  it("a Google Sheets error for one member is isolated and a re-run completes it without duplicates", async () => {
    sheets.failNext = { op: "append", error: googleError(500) }; // the first ledger claim (Anni) fails
    const first = await runDailyNotifications("morning", MORNING, noPause);
    expect(first.ran && first.results.map((r) => r.outcome)).toEqual(["error", "sent", "sent"]);
    const second = await runDailyNotifications("morning", new Date(MORNING.getTime() + 600_000), noPause);
    expect(second.ran && second.results.map((r) => r.outcome)).toEqual(["sent", "already_sent", "already_sent"]);
    expect(sender).toHaveBeenCalledTimes(3);
  });

  it("retries a transient failure when loading subscriptions within the same run", async () => {
    // Fail the first read of PushSubscriptions only.
    let failed = false;
    const realGet = sheets.getValues.bind(sheets);
    sheets.getValues = async (range: string) => {
      if (range.startsWith("PushSubscriptions") && !failed) {
        failed = true;
        throw googleError(503);
      }
      return realGet(range);
    };
    const run = await runDailyNotifications("morning", MORNING, noPause);
    expect(run.ran && run.results.map((r) => r.outcome)).toEqual(["sent", "sent", "sent"]);
    expect(sender).toHaveBeenCalledTimes(3);
  });

  it("refuses to send (no duplicate risk) when the NotificationLog tab is missing", async () => {
    sheets.tabs.delete("NotificationLog");
    const run = await runDailyNotifications("morning", MORNING, noPause);
    expect(run.ran && run.results.every((r) => r.outcome === "error")).toBe(true);
    expect(sender).not.toHaveBeenCalled();
  });

  it("a night run whose Jobs read fails claims and sends nothing, so it can simply be retried", async () => {
    sheets.failNext = { op: "get", error: googleError(500) };
    sheets.failAll = null;
    await expect(runDailyNotifications("night", NIGHT, noPause)).rejects.toBeTruthy();
    expect(sender).not.toHaveBeenCalled();
    expect(ledger()).toHaveLength(0);
    const retry = await runDailyNotifications("night", NIGHT, noPause);
    expect(retry.ran && retry.results.every((r) => r.outcome === "sent")).toBe(true);
  });

  it("skips inactive members", async () => {
    sheets = new FakeSheets().seedMembers({ lukky: false });
    setSheetsClientForTesting(sheets);
    resetMembersCache();
    for (const m of MEMBER_IDS) await subscribe(m);
    const run = await runDailyNotifications("morning", MORNING, noPause);
    expect(run.ran && run.results.map((r) => r.outcome)).toEqual(["sent", "inactive", "sent"]);
  });

  it("recovers from a run that crashed after claiming (expired claim)", async () => {
    sheets.rows("NotificationLog").push(["morning:anni:2026-10-13", "clm_dead", "anni", "morning", "2026-10-13", "claimed", "2026-10-13T04:00:00.000Z", "2026-10-13T04:00:00.000Z", ""]);
    const run = await runDailyNotifications("morning", MORNING, noPause);
    expect(run.ran && run.results[0].outcome).toBe("sent");
  });

  it("does not take over a claim another run made seconds ago", async () => {
    const t = new Date(MORNING.getTime() - 20_000).toISOString();
    sheets.rows("NotificationLog").push(["morning:anni:2026-10-13", "clm_live", "anni", "morning", "2026-10-13", "claimed", t, t, ""]);
    const run = await runDailyNotifications("morning", MORNING, noPause);
    expect(run.ran && run.results[0].outcome).toBe("in_progress");
    expect(to("anni")).toHaveLength(0);
  });

  it("prunes old ledger rows only", async () => {
    sheets.rows("NotificationLog").push(["morning:anni:2026-09-01", "clm_old", "anni", "morning", "2026-09-01", "sent", "2026-09-01T04:30:00.000Z", "2026-09-01T04:30:00.000Z", ""]);
    await runDailyNotifications("morning", MORNING, noPause);
    expect(ledger().some((r) => r[4] === "2026-09-01")).toBe(false);
    expect(sentRows()).toHaveLength(3);
  });
});

describe("timing window", () => {
  it("refuses to send before 10:00 AM or at the wrong time of day", async () => {
    const early = await runDailyNotifications("morning", new Date("2026-10-13T04:29:00Z"), noPause); // 09:59 IST
    expect(early).toMatchObject({ ran: false, reason: "outside_window" });
    expect(await runDailyNotifications("morning", NIGHT, noPause)).toMatchObject({ ran: false });
    expect(await runDailyNotifications("night", MORNING, noPause)).toMatchObject({ ran: false });
    expect(sender).not.toHaveBeenCalled();
    expect(ledger()).toHaveLength(0);
  });

  it("accepts a slightly late scheduler but not one that fires after midnight (night)", async () => {
    expect((await runDailyNotifications("morning", new Date("2026-10-13T05:59:00Z"), noPause)).ran).toBe(true); // 11:29 IST
    expect((await runDailyNotifications("night", new Date("2026-10-13T18:29:00Z"), noPause)).ran).toBe(true); // 23:59 IST
    expect(await runDailyNotifications("night", new Date("2026-10-13T18:30:00Z"), noPause)).toMatchObject({ ran: false, reason: "outside_window" }); // 00:00 IST next day
  });

  it("follows APP_TIMEZONE", async () => {
    vi.stubEnv("APP_TIMEZONE", "America/New_York");
    const run = await runDailyNotifications("morning", new Date("2026-10-13T14:00:00Z"), noPause); // 10:00 EDT
    expect(run).toMatchObject({ ran: true, date: "2026-10-13", timeZone: "America/New_York" });
  });
});

describe("GET /api/cron/daily-notifications", () => {
  const call = (slot: string | null, auth: string | null = "Bearer test-cron-secret") =>
    cron(new Request(`http://localhost/api/cron/daily-notifications${slot ? `?slot=${slot}` : ""}`, { headers: auth ? { authorization: auth } : {} }));

  it("rejects missing or wrong credentials without doing anything", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(MORNING);
    for (const auth of [null, "Bearer wrong", "test-cron-secret", "Bearer "]) {
      expect((await call("morning", auth)).status).toBe(401);
    }
    expect(sender).not.toHaveBeenCalled();
  });

  it("is disabled until CRON_SECRET is set", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await call("morning")).status).toBe(503);
  });

  it("validates the slot", async () => {
    expect((await call(null)).status).toBe(400);
    expect((await call("noon")).status).toBe(400);
  });

  it("sends once at 10 AM and reports each member; a repeat call sends nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(MORNING);
    const res = await call("morning");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.results.map((r: { outcome: string }) => r.outcome)).toEqual(["sent", "sent", "sent"]);
    expect(JSON.stringify(body)).not.toContain("fcm.googleapis.com");
    expect(JSON.stringify(body)).not.toContain("test-cron-secret");
    const again = await call("morning");
    expect(again.status).toBe(200);
    expect(sender).toHaveBeenCalledTimes(3);
  });

  it("answers 409 outside the window and 503 (retryable) when a member's delivery failed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T08:00:00Z")); // 13:30 IST
    expect((await call("morning")).status).toBe(409);
    vi.setSystemTime(MORNING);
    sender.mockResolvedValue({ ok: false, gone: false, status: 503 });
    expect((await call("morning")).status).toBe(503);
  });

  it("never logs the secret, subscription endpoints or message text", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(MORNING);
    const spies = [vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "log")].map((s) => s.mockImplementation(() => undefined));
    sender.mockResolvedValue({ ok: false, gone: true, status: 410 });
    await call("morning");
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    for (const secret of ["test-cron-secret", "fcm.googleapis.com", "Good morning", "priv"]) expect(logged).not.toContain(secret);
    spies.forEach((s) => s.mockRestore());
  });
});
