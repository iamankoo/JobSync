/**
 * Milestone notifications raised by JobSync's automation, delivered to ALL THREE members' devices:
 *   - "10 connections added" per 10 Connections the Outreach Database import successfully CREATED (10, 20, 30, ...);
 *   - "10 emails sent" per 10 CONFIRMED automated sends (independent counter and milestones).
 * There is NO per-Connection or per-email notification. In-memory sheets and a recording push sender; nothing real is contacted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_IDS, type MemberId } from "@/config/members";
import { createConnection } from "@/lib/google-sheets/connections-service";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { saveSubscription } from "@/lib/google-sheets/push-service";
import { invalidateTableCache } from "@/lib/google-sheets/table";
import { notifyEveryone, resetPushDedupeForTesting, setPushSenderForTesting, type PushSender } from "@/lib/push/notify";
import { announceConnectionMilestones, announceSentBlocks, type AnnounceDeps, type NotifyAll } from "@/lib/outreach/announce";
import { loadOutreachConfig } from "@/lib/outreach/config";
import { realConnectionsPort, runOutreachCycle, type CycleDeps } from "@/lib/outreach/run";
import { MILESTONE_CLAIM_TTL_MS } from "@/lib/outreach/sheet";
import { TRACKING_TAB, type SendRecord } from "@/lib/outreach/types";
import { createConnectionSchema } from "@/lib/validation/connections";
import { FakeSheets, googleError } from "../helpers/fake-sheets";
import { manyContacts, masterGrid, masterRow, newOutreachSpreadsheet } from "../helpers/outreach";

type Delivery = { member: MemberId; endpoint: string; payload: { title: string; body: string; url: string; tag: string } };
let prod: FakeSheets;
let outreach: ReturnType<typeof newOutreachSpreadsheet>;
let delivered: Delivery[];
let clock = new Date("2026-11-06T06:00:00.000Z");
const now = () => clock;

const endpointOf = (m: MemberId, n = 1) => `https://fcm.googleapis.com/fcm/send/${m}-device-${n}`;
const keys = { p256dh: "BPk1234567890abcd", auth: "auth1234567890" };
const connNotes = () => delivered.filter((d) => /connections added$/.test(d.payload.title));
const mailNotes = () => delivered.filter((d) => /emails sent$/.test(d.payload.title));
const titles = () => delivered.map((d) => d.payload.title);

/** The real delivery path (all members' devices) as the cycle uses it. */
const realNotify: NotifyAll = async (p, k) => ((await notifyEveryone(p, k)).status === "unreadable" ? "retry" : "done");

const cycle = (over: Partial<CycleDeps> = {}): CycleDeps => ({
  config: loadOutreachConfig({ OUTREACH_ENABLED: "true", OUTREACH_SPREADSHEET_ID: "x" } as unknown as NodeJS.ProcessEnv),
  sheet: outreach.sheet,
  connections: realConnectionsPort,
  ledger: async () => new Map(),
  connected: async () => [...MEMBER_IDS],
  notify: realNotify,
  now,
  timezone: "Asia/Kolkata",
  ...over,
});
const ann = (over: Partial<AnnounceDeps> = {}): AnnounceDeps => ({ sheet: outreach.sheet, notify: realNotify, now, ...over });
const added = () => outreach.fake.dataRows(TRACKING_TAB).filter((t) => t[0] && t[3] === "added").length;

/** Runs the cron cycle until `n` contacts have been imported (each call imports at most 10). */
async function importUntil(n: number, over: Partial<CycleDeps> = {}) {
  for (let i = 0; i < 12 && added() < n; i++) await runOutreachCycle(cycle(over));
  expect(added()).toBe(n);
}
/** n eligible contacts with their own distinct addresses (so a second batch is never mistaken for duplicates of the first). */
const batch = (tag: string, n: number) => Array.from({ length: n }, (_, i) => masterRow({ PersonEmail: `${tag}${i}@${tag}${i}.example.com`, PersonName: `${tag} Person${i}`, CompanyName: `${tag} Co${i}` }));
const importedByJobSync = () => outreach.fake.dataRows(TRACKING_TAB).filter((t) => t[0] && t[2] === "outreach-database" && t[3] === "added").length;
const withContacts = async (rows: string[][]) => {
  outreach = newOutreachSpreadsheet(masterGrid(rows));
  await outreach.sheet.ensureTabs();
};

const sentRow = (i: number, over: Partial<SendRecord> = {}): SendRecord => ({
  row: 0, sendKey: `p${i}@c${i}.example.com`, contactId: `HRC-${i}`, claimId: `claim-${i}-${Math.random()}`, status: "sent", member: MEMBER_IDS[i % 3], gmailAccount: "", connectionId: `conn_${i}`, company: "", role: "", resumeFile: "", resumeSha256: "", resumeBytes: 0,
  draftId: "", threadId: "", gmailMessageId: `m${i}`, wordCount: 90, attempts: 1, notBefore: "", sentAt: now().toISOString(), sentDay: "2026-11-06", reason: "", history: "", createdAt: now().toISOString(), updatedAt: now().toISOString(), ...over,
});
async function addSent(from: number, to: number, over: Partial<SendRecord> = {}) {
  for (let i = from; i < to; i++) {
    const { nextRow } = await outreach.sheet.readSendLedger();
    await outreach.sheet.appendSendRecord(sentRow(i, over), nextRow);
  }
}

beforeEach(async () => {
  clock = new Date("2026-11-06T06:00:00.000Z");
  vi.stubEnv("VAPID_PUBLIC_KEY", "test-public-key");
  vi.stubEnv("VAPID_PRIVATE_KEY", "test-private-key");
  prod = new FakeSheets().seedMembers();
  setSheetsClientForTesting(prod);
  resetMembersCache();
  invalidateTableCache();
  resetPushDedupeForTesting();
  delivered = [];
  const sender = vi.fn<PushSender>(async (sub, payload) => {
    delivered.push({ member: sub.memberId, endpoint: sub.endpoint, payload });
    return { ok: true };
  });
  setPushSenderForTesting(sender);
  for (const m of MEMBER_IDS) await saveSubscription(m, { endpoint: endpointOf(m), keys });
  await withContacts([]);
});
afterEach(() => {
  setPushSenderForTesting(null);
  setSheetsClientForTesting(null);
  vi.unstubAllEnvs();
});

describe("\"10 connections added\" milestones", () => {
  it("9 successful imports -> no notification at all", async () => {
    await withContacts(manyContacts(9));
    await importUntil(9);
    expect(delivered).toEqual([]);
  });

  it("10 successful imports -> exactly one notification, delivered to all three members' devices, opening /connections", async () => {
    await withContacts(manyContacts(10));
    await importUntil(10);
    expect(connNotes()).toHaveLength(3); // ONE notification, delivered to the one registered device of each of the three members
    expect(connNotes().map((d) => d.member).sort()).toEqual(["anni", "lukky", "rishii"]);
    expect(new Set(connNotes().map((d) => d.payload.tag)).size).toBe(1);
    expect(connNotes()[0].payload).toMatchObject({ title: "10 connections added", url: "/connections" });
    expect(connNotes()[0].payload.body).toContain("10 connections");
    // no per-Connection notification of any kind
    expect(titles().every((t) => t === "10 connections added")).toBe(true);
    expect(JSON.stringify(delivered)).not.toMatch(/Connection added by JobSync|@c\d+\.example\.com/);
  });

  it("20 successful imports -> two milestone notifications in total (10 and 20); 25 -> still two", async () => {
    await withContacts(manyContacts(25));
    await importUntil(20);
    expect(connNotes()).toHaveLength(6); // 2 milestones x 3 members
    expect(connNotes().map((d) => d.payload.tag).filter((t, i, a) => a.indexOf(t) === i)).toHaveLength(2);
    expect(connNotes().filter((d) => d.member === "anni").map((d) => d.payload.body).join("|")).toMatch(/10 connections.*20 connections/);
    await importUntil(25);
    expect(connNotes()).toHaveLength(6);
  });

  it("every milestone is a multiple of 10: 10, 20, 30, 40, 50", async () => {
    await withContacts(manyContacts(50));
    await importUntil(50);
    const totals = [...new Set(connNotes().map((d) => d.payload.body.match(/added (\d+) connections/)![1]))].sort((a, b) => Number(a) - Number(b));
    expect(totals).toEqual(["10", "20", "30", "40", "50"]);
    expect(connNotes()).toHaveLength(15);
    expect(await outreach.sheet.claimedMilestones(now().toISOString())).toEqual(new Set(["connections:10", "connections:20", "connections:30", "connections:40", "connections:50"]));
  });

  it("manual Connections are excluded: 10 added by hand (+5 imports) is not a milestone, and they keep their existing notification", async () => {
    for (let i = 0; i < 10; i++) {
      await createConnection(MEMBER_IDS[i % 3], createConnectionSchema.parse({ name: `Manual ${i}`, company: `Co${i}`, email: `manual${i}@man${i}.example.com`, roleCategory: "SDE", applyRole: "Software Engineer", status: "Not Connected" }));
    }
    await vi.waitFor(() => expect(titles().filter((t) => t.includes("added a connection")).length).toBe(20)); // existing: each tells the OTHER two members
    delivered.length = 0;
    await withContacts(manyContacts(5));
    await importUntil(15); // 5 imports + the 10 manual Connections get tracked as manual
    expect(connNotes()).toEqual([]);
    expect(outreach.fake.dataRows(TRACKING_TAB).filter((t) => t[0] && t[2] === "manual")).toHaveLength(10);
  });

  it("duplicates, failed imports and skipped contacts are excluded", async () => {
    // 3 already in Connections (duplicates), 2 ineligible (skipped), 2 that always fail to be created, then 7 good ones
    for (let i = 0; i < 3; i++) await createConnection("rishii", createConnectionSchema.parse({ name: `Dup ${i}`, company: "D", email: `dup${i}@dup.example.com`, roleCategory: "SDE", applyRole: "Software Engineer", status: "Not Connected" }));
    await vi.waitFor(() => expect(titles().length).toBeGreaterThan(0));
    delivered.length = 0;
    await withContacts([
      ...[0, 1, 2].map((i) => masterRow({ PersonEmail: `dup${i}@dup.example.com`, PersonName: `Dup ${i}`, CompanyName: "D" })),
      masterRow({ PersonEmail: "old@vsnl.net.in", PersonName: "Old Mail", CompanyName: "Old", EmailKind: "legacy-isp" }),
      masterRow({ PersonEmail: "angel@fund.example.com", PersonName: "Ann Angel", CompanyName: "Fund", PersonDesignation: "Angel Investor" }),
      ...[0, 1].map((i) => masterRow({ PersonEmail: `fail${i}@fail.example.com`, PersonName: `Fail ${i}`, CompanyName: "F" })),
      ...manyContacts(7),
    ]);
    const flaky = { ...realConnectionsPort, create: async (o: MemberId, i: Parameters<typeof realConnectionsPort.create>[1]) => { if (i.email?.startsWith("fail")) throw new Error("always fails"); return realConnectionsPort.create(o, i); } };
    for (let i = 0; i < 14; i++) { await runOutreachCycle(cycle({ connections: flaky })); clock = new Date(clock.getTime() + 3 * 60_000); } // a stalled claim is only taken over after 2 minutes
    const rows = outreach.fake.dataRows(TRACKING_TAB).filter((t) => t[0]);
    expect(rows.filter((t) => t[3] === "added" && t[2] === "outreach-database")).toHaveLength(7);
    expect(rows.filter((t) => t[3] === "import_failed")).toHaveLength(2);
    expect(connNotes()).toEqual([]); // only 7 successful imports so far
    // three more good contacts make it 10 successful imports -> exactly one milestone
    // three more good contacts arrive: now 10 SUCCESSFUL JobSync imports -> exactly one milestone
    outreach.fake.tabs.get("Master Contacts")!.push(...batch("late", 3));
    for (let i = 0; i < 6 && importedByJobSync() < 10; i++) { await runOutreachCycle(cycle({ connections: flaky })); clock = new Date(clock.getTime() + 3 * 60_000); }
    expect(importedByJobSync()).toBe(10);
    expect(connNotes()).toHaveLength(3);
  });

  it("cron retries and a fresh server instance never repeat a milestone", async () => {
    await withContacts(manyContacts(10));
    await importUntil(10);
    const first = delivered.length;
    for (let i = 0; i < 5; i++) await runOutreachCycle(cycle());
    expect(delivered.length).toBe(first);
    resetPushDedupeForTesting(); // another instance has no in-memory memory of it: the durable record in Outreach State still prevents a repeat
    await runOutreachCycle(cycle());
    expect(delivered.length).toBe(first);
    const stateRows = outreach.fake.dataRows("Outreach State").filter((r) => r[0].startsWith("milestone:connections:10"));
    expect(stateRows).toHaveLength(1);
    expect(stateRows[0][1]).toMatch(/^done:/);
    expect(await outreach.sheet.getState("connections-announced")).toBe("10");
  });

  it("overlapping executions announce a milestone exactly once (claim in the Outreach State tab)", async () => {
    await withContacts(manyContacts(10));
    await importUntil(10, { notify: undefined }); // imports tracked, nothing announced yet
    expect(delivered).toEqual([]);
    const calls: string[] = [];
    const slow: NotifyAll = async (_p, k) => { calls.push(k); await new Promise((r) => setTimeout(r, 15)); return "done"; };
    const results = await Promise.all(Array.from({ length: 6 }, () => announceConnectionMilestones(ann({ notify: slow }))));
    expect(calls).toHaveLength(1);
    expect(results.reduce((n, r) => n + r.announced, 0)).toBe(1);
  });

  it("delivery failure: the claim is released, nothing is lost and nothing is repeated, however many retries", async () => {
    await withContacts(manyContacts(10));
    await importUntil(10, { notify: undefined });
    let attempts = 0;
    const flaky: NotifyAll = async (p, k) => (++attempts <= 2 ? "retry" : realNotify(p, k));
    expect((await announceConnectionMilestones(ann({ notify: flaky }))).announced).toBe(0);
    expect((await announceConnectionMilestones(ann({ notify: flaky }))).announced).toBe(0);
    expect(delivered).toEqual([]);
    expect(await outreach.sheet.getState("connections-announced")).toBeUndefined(); // nothing recorded as announced
    expect((await announceConnectionMilestones(ann({ notify: flaky }))).announced).toBe(1);
    expect(connNotes()).toHaveLength(3);
    expect((await announceConnectionMilestones(ann({ notify: flaky }))).announced).toBe(0);
    expect(connNotes()).toHaveLength(3);
    // a notifier that throws is treated like a failed delivery
    await withContacts(batch("second", 10));
    for (let i = 0; i < 6 && importedByJobSync() < 10; i++) await runOutreachCycle(cycle({ notify: undefined }));
    expect(importedByJobSync()).toBe(10);
    delivered.length = 0;
    await announceConnectionMilestones(ann({ notify: async () => { throw new Error("boom"); } }));
    expect((await announceConnectionMilestones(ann())).announced).toBe(1);
  });

  it("device lookup failure at the push layer is a retry, not a loss", async () => {
    await withContacts(manyContacts(10));
    await importUntil(10, { notify: undefined });
    prod.failAll = googleError(500);
    expect((await announceConnectionMilestones(ann())).announced).toBe(0);
    prod.failAll = null;
    invalidateTableCache();
    expect((await announceConnectionMilestones(ann())).announced).toBe(1);
    expect(connNotes()).toHaveLength(3);
  });

  it("a crash after claiming but before delivering is recovered once the claim goes stale, and not before", async () => {
    await withContacts(manyContacts(10));
    await importUntil(10, { notify: undefined });
    expect(await outreach.sheet.claimMilestone("connections:10", "crashed-worker", clock.toISOString())).toBe(true); // claimed, then the process died
    expect((await announceConnectionMilestones(ann())).announced).toBe(0); // looks in flight: not announced twice
    expect(delivered).toEqual([]);
    clock = new Date(clock.getTime() + MILESTONE_CLAIM_TTL_MS + 1000);
    expect((await announceConnectionMilestones(ann())).announced).toBe(1);
    expect(connNotes()).toHaveLength(3);
    expect((await announceConnectionMilestones(ann())).announced).toBe(0);
  });

  it("the old per-Connection notification is gone: no 'Connection added by JobSync' exists anywhere", async () => {
    await withContacts(manyContacts(12));
    await importUntil(12);
    expect(titles().some((t) => /Connection added by JobSync/i.test(t))).toBe(false);
    const fs = await import("node:fs");
    const path = await import("node:path");
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const hits = walk(path.resolve(import.meta.dirname, "../../src")).filter((f) => /\.(ts|tsx)$/.test(f) && /Connection added by JobSync|jobSyncConnectionAddedPayload|announceAddedConnections/.test(fs.readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});

describe("existing notifications are unchanged", () => {
  it("a Connection a member adds by hand still notifies the OTHER two members with the existing wording, and never counts toward the JobSync milestone", async () => {
    await createConnection("anni", createConnectionSchema.parse({ name: "Max Manual", company: "Zed", role: "CTO", email: "max@zed.example.com", roleCategory: "SDE", applyRole: "Software Engineer", status: "Not Connected" }));
    await vi.waitFor(() => expect(delivered.length).toBe(2));
    expect(delivered.map((d) => d.member).sort()).toEqual(["lukky", "rishii"]); // the actor is never a recipient
    expect(delivered[0].payload).toMatchObject({ title: "Anni added a connection: Max Manual", url: "/connections" });
    expect(delivered[0].payload.body).toBe("CTO · Zed — tap to view in Connections.");
    await runOutreachCycle(cycle());
    expect(connNotes()).toEqual([]);
  });
});

describe("\"10 emails sent\" is independent of the connection milestones", () => {
  it("9 sends: nothing; the 10th: ONE notification to all three members; counters and milestones are separate", async () => {
    await addSent(0, 9);
    expect((await announceSentBlocks(ann())).announced).toBe(0);
    expect(mailNotes()).toEqual([]);
    await addSent(9, 10);
    expect(await announceSentBlocks(ann())).toMatchObject({ announced: 1, total: 10, announcedUpTo: 10 });
    expect(mailNotes()).toHaveLength(3);
    expect(mailNotes().map((d) => d.member).sort()).toEqual(["anni", "lukky", "rishii"]);
    expect(mailNotes()[0].payload).toMatchObject({ title: "10 emails sent", url: "/gmail" });
    expect(await outreach.sheet.getState("emails-announced")).toBe("10");
    expect(connNotes()).toEqual([]);
  });

  it("10 imports and 10 sends produce two different notifications, each exactly once", async () => {
    await withContacts(manyContacts(10));
    await importUntil(10);
    await addSent(0, 10);
    await runOutreachCycle(cycle());
    await runOutreachCycle(cycle());
    expect(connNotes()).toHaveLength(3);
    expect(mailNotes()).toHaveLength(3);
    expect(new Set(delivered.map((d) => d.payload.tag)).size).toBe(2);
    expect(await outreach.sheet.claimedMilestones(now().toISOString())).toEqual(new Set(["connections:10", "emails:10"]));
  });

  it("25 sends -> blocks at 10 and 20 only; confirmed sends only; retries repeat nothing; delivery failure is retried safely", async () => {
    await addSent(0, 25);
    await addSent(100, 108, { status: "uncertain" });
    await addSent(200, 203, { gmailMessageId: "" });
    await addSent(0, 3); // duplicate ledger rows
    await announceSentBlocks(ann());
    expect(mailNotes()).toHaveLength(6);
    for (let i = 0; i < 3; i++) await announceSentBlocks(ann());
    expect(mailNotes()).toHaveLength(6);
    await addSent(25, 30);
    await announceSentBlocks(ann({ notify: async () => "retry" }));
    expect(mailNotes()).toHaveLength(6);
    await announceSentBlocks(ann());
    expect(mailNotes()).toHaveLength(9);
  });
});

describe("respects the existing delivery rules", () => {
  it("only opted-in devices receive it: a member without a device gets nothing; one browser shared by two members gets it once; push not configured sends nothing", async () => {
    prod.tabs.set("PushSubscriptions", prod.rows("PushSubscriptions").filter((r) => r[1] !== "rishii"));
    invalidateTableCache();
    await saveSubscription("lukky", { endpoint: endpointOf("anni"), keys }); // anni's browser, also signed in as lukky
    invalidateTableCache();
    await withContacts(manyContacts(10));
    await importUntil(10);
    expect(connNotes().some((d) => d.member === "rishii")).toBe(false);
    const eps = connNotes().map((d) => d.endpoint);
    expect(new Set(eps).size).toBe(eps.length);
    expect(eps).toContain(endpointOf("anni"));
    expect(eps).toContain(endpointOf("lukky"));
    delivered.length = 0;
    vi.unstubAllEnvs();
    vi.stubEnv("VAPID_PUBLIC_KEY", "");
    vi.stubEnv("VAPID_PRIVATE_KEY", "");
    await withContacts(manyContacts(10));
    const r = await runOutreachCycle(cycle());
    expect(r.errors).toEqual([]);
    expect(delivered).toEqual([]);
  });
});
