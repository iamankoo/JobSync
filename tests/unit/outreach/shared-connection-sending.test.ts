/**
 * The shared-Connection workflow: ONE Connection -> one separately personalised e-mail per member, each sent from that member's own
 * Gmail with that member's own resume; no JobSync sending cap; (member, recipient) idempotency. MOCK ports only.
 */
import { describe, expect, it } from "vitest";
import type { MemberId } from "@/config/members";
import { runSendStep } from "@/lib/outreach/send-workflow";
import { computeCounters } from "@/lib/outreach/sync";
import { buildSendFixture, resumeFile } from "../../helpers/send-fixture";

const ALL: MemberId[] = ["anni", "lukky", "rishii"];
const people = (n: number) => Array.from({ length: n }, (_, i) => ({ email: `p${i}@c${i}.example.com`, name: `Pat Person${i}`, company: `Co${i}`, members: ALL }));
const ONE = people(1);

describe("one shared Connection -> three separate e-mails", () => {
  it("each member sends their OWN draft from their OWN account with their OWN resume; the same recipient receives three e-mails", async () => {
    const f = buildSendFixture(ONE);
    await f.seed();
    const r = await runSendStep(f.deps());
    expect(r).toMatchObject({ sent: 3, errors: [] });
    expect(f.gmail.sendCalls().sort()).toEqual(["send:anni:draft_0_anni", "send:lukky:draft_0_lukky", "send:rishii:draft_0_rishii"]);
    const rows = f.ledger();
    expect(rows.map((l) => l[0]).sort()).toEqual(["anni|p0@c0.example.com", "lukky|p0@c0.example.com", "rishii|p0@c0.example.com"]);
    for (const m of ALL) {
      const l = rows.find((x) => x[4] === m)!;
      expect(l[3]).toBe("sent");
      expect(l[5]).toBe({ anni: "aniket@gmail.test", lukky: "lakshya@gmail.test", rishii: "rishi@gmail.test" }[m]);
      expect(l[9]).toBe(resumeFile(m)); // never another member's resume
    }
    const [t] = f.track();
    expect([t[21], t[26]]).toEqual(["sent", "anni,lukky,rishii"]);
    expect(f.calls.markSent.sort()).toEqual(["anni:conn_0", "lukky:conn_0", "rishii:conn_0"]);
    expect(f.calls.markMessaged).toEqual(["conn_0"]); // the shared Connection is marked once, after ALL three
  });

  it("per-member counters are independent: one Connection is three sends, not one", async () => {
    const f = buildSendFixture(people(2));
    await f.seed();
    await runSendStep(f.deps());
    const c = computeCounters((await f.sheet.readTracking()).records, "2026-11-06", 0, { ledger: (await f.sheet.readSendLedger()).records });
    expect(c.sentTodayByMember).toEqual({ anni: 2, lukky: 2, rishii: 2 });
    expect(c.sentToday).toBe(6);
  });

  it("a send by one member never blocks the same recipient for the others, but the same account is never used twice", async () => {
    const f = buildSendFixture(ONE);
    f.gmail.addresses.lukky = null; // Lakshya is disconnected: only Aniket and Rishi send
    await f.seed();
    expect((await runSendStep(f.deps())).sent).toBe(2);
    expect(f.track()[0][21]).toBe("pending");
    expect(f.track()[0][25]).toMatch(/lukky: \[member_identity\]/);
    for (let i = 0; i < 3; i++) expect((await runSendStep(f.deps())).sent).toBe(0); // repeated cron runs: no second e-mail from any account
    expect(f.gmail.sendCalls()).toHaveLength(2);
    f.gmail.addresses.lukky = "lakshya@gmail.test"; // reconnects through the normal flow: only Lakshya's remaining e-mail goes out
    expect((await runSendStep(f.deps())).sent).toBe(1);
    expect(f.gmail.sendCalls()).toHaveLength(3);
    expect(f.track()[0][21]).toBe("sent");
  });

  it("a missing resume holds ONLY that member's e-mail for review; nobody else is affected and no wrong file is attached", async () => {
    const f = buildSendFixture(ONE);
    await f.seed();
    const deps = f.deps({ resumes: async (member) => (member === "lukky" ? { status: "unmapped", reason: "no SDE resume uploaded" } : { status: "attached", attachment: { fileName: resumeFile(member as MemberId), mimeType: "application/pdf", bytes: new TextEncoder().encode(`%PDF-1.4 resume of ${member} ${"x".repeat(40)}`) } }) });
    const r = await runSendStep(deps);
    expect(r.sent).toBe(2);
    expect(f.gmail.sendCalls().some((c) => c.includes("lukky"))).toBe(false);
    expect(f.track()[0][21]).toBe("review");
    expect(f.track()[0][25]).toMatch(/lukky: \[resume\] resume unavailable/);
  });

  it("an invalid recipient is never sent by any member", async () => {
    const f = buildSendFixture(ONE);
    f.tracking[0].email = "not-an-address";
    await f.seed();
    expect((await runSendStep(f.deps())).sent).toBe(0);
    expect(f.gmail.sendCalls()).toEqual([]);
  });

  it("an opt-out blocks every member", async () => {
    const f = buildSendFixture(ONE);
    f.fake.tabs.set("Outreach Exclusions", [["Value", "Reason", "AddedAt", "AddedBy"], ["c0.example.com", "asked not to be contacted", "", "anni"]]);
    await f.seed();
    expect((await runSendStep(f.deps())).sent).toBe(0);
    expect(f.gmail.sendCalls()).toEqual([]);
  });
});

describe("no JobSync sending cap: every member's e-mails keep going out, independently", () => {
  it("one shared Connection per person -> all three members' e-mails are sent, for any number of Connections", async () => {
    const f = buildSendFixture(people(40));
    await f.seed();
    const r = await runSendStep(f.deps());
    expect(r).toMatchObject({ sent: 120, stoppedBecause: "none" });
    for (const m of ALL) expect(f.gmail.sendCalls().filter((c) => c.startsWith(`send:${m}:`))).toHaveLength(40);
  });

  it("a calendar-day change or the passage of time changes nothing: there is no window to wait for", async () => {
    const f = buildSendFixture(people(4));
    await f.seed();
    expect((await runSendStep(f.deps())).sent).toBe(12);
    f.clock.now = new Date(f.clock.now.getTime() + 13 * 3600_000);
    expect((await runSendStep(f.deps())).sent).toBe(0); // nothing left, not "limited"
    expect(f.gmail.sendCalls()).toHaveLength(12);
  });

  it("concurrent workers never send one (member, recipient) twice", async () => {
    const f = buildSendFixture(people(6));
    await f.seed();
    await Promise.all([runSendStep(f.deps()), runSendStep(f.deps()), runSendStep(f.deps())]);
    const sent = f.ledger().filter((l) => l[3] === "sent");
    expect(new Set(sent.map((l) => l[0])).size).toBe(sent.length); // never two sends for one (member, recipient)
    expect(f.gmail.sendCalls().length).toBe(new Set(f.gmail.sendCalls()).size);
  });
});
