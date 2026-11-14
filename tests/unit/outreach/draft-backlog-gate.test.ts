/**
 * Draft backlog protection, PER MEMBER: 100+ unsent JobSync drafts in ONE member's Gmail pause new drafting for THAT member only; sending is never gated.
 * Unit level: the counting rules, the 99/100 boundary, fail-closed behaviour, caching, and every code path that creates drafts.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MemberId } from "@/config/members";
import { DRAFT_BACKLOG_LIMIT, countPendingGmailDrafts, createBacklogGate, type BacklogPorts, type MemberDrafts, type PendingLedgerDraft } from "@/lib/gmail/draft-backlog";
import { loadNetworkFinderConfig } from "@/lib/network-finder/config";
import { createSelectionDrafts, draftForContact, runPendingDrafts, type PipelineDeps } from "@/lib/network-finder/pipeline";
import { MockMailboxes } from "../../helpers/network-finder-mocks";

const MEMBERS3: MemberId[] = ["anni", "lukky", "rishii"];
const config = loadNetworkFinderConfig({ DRAFT_DELAY_MINUTES: "0", NETWORK_FINDER_ENABLED: "true" } as unknown as NodeJS.ProcessEnv);

/** n ledger drafts for a member, ids `${member}-${i}`. */
const ledgerDrafts = (member: MemberId, n: number, detail = ""): PendingLedgerDraft[] => Array.from({ length: n }, (_, i) => ({ memberId: member, gmailDraftId: `${member}-${i}`, detail }));
const idsOf = (ds: PendingLedgerDraft[]) => new Set(ds.map((d) => d.gmailDraftId));

function ports(ledger: PendingLedgerDraft[], gmail: Partial<Record<MemberId, MemberDrafts | "throw">> = {}): BacklogPorts & { listCalls: () => number; ledgerCalls: () => number } {
  let lists = 0;
  let ledgers = 0;
  return {
    ledgerPending: async () => { ledgers += 1; return ledger; },
    gmailDraftIds: async (m) => {
      lists += 1;
      const g = gmail[m];
      if (g === "throw") throw new Error("boom");
      return g ?? { status: "ok", ids: idsOf(ledger.filter((d) => d.memberId === m)) };
    },
    listCalls: () => lists,
    ledgerCalls: () => ledgers,
  };
}

describe("the limit", () => {
  it("is 100", () => expect(DRAFT_BACKLOG_LIMIT).toBe(100));
});

describe("what is counted: the unsent JobSync drafts that really are in the members' Gmail", () => {
  it("counts each member's pending drafts separately, and the total", async () => {
    const c = await countPendingGmailDrafts(ports([...ledgerDrafts("anni", 5), ...ledgerDrafts("lukky", 3), ...ledgerDrafts("rishii", 2)]));
    expect(c).toMatchObject({ status: "ok", pending: 10, byMember: { anni: 5, lukky: 3, rishii: 2 } });
  });

  it("a draft that is gone from Gmail (sent or deleted) is not counted, whatever the ledger still says", async () => {
    const ledger = ledgerDrafts("anni", 6);
    const present = new Set([...idsOf(ledger)].slice(0, 4)); // two were sent / deleted in Gmail
    const c = await countPendingGmailDrafts(ports(ledger, { anni: { status: "ok", ids: present } }));
    expect(c).toMatchObject({ status: "ok", byMember: { anni: 4, lukky: 0, rishii: 0 } });
  });

  it("drafts the members wrote themselves are never counted (they are not JobSync-generated)", async () => {
    const ledger = ledgerDrafts("anni", 3);
    const theirOwn = new Set([...idsOf(ledger), "hand-written-1", "hand-written-2", "hand-written-3"]);
    const c = await countPendingGmailDrafts(ports(ledger, { anni: { status: "ok", ids: theirOwn } }));
    expect(c).toMatchObject({ status: "ok", pending: 3 });
  });

  it("a draft whose ledger row is not 'created' is never in the input: confirmed-sent drafts are excluded by the ledger port", async () => {
    // The real port only returns status "created" rows with a Gmail id; sent / failed / skipped rows never reach the count.
    const c = await countPendingGmailDrafts(ports([]));
    expect(c).toMatchObject({ status: "ok", pending: 0 });
  });

  it("an unresolved (uncertain) send whose draft is still in Gmail IS counted: it is not finished, and it is never resent blindly", async () => {
    // An uncertain send leaves the ledger row 'created' (only a confirmed send marks it 'sent') and the draft in Gmail.
    const c = await countPendingGmailDrafts(ports(ledgerDrafts("lukky", 1, "attached: Lakshya_SDE.pdf")));
    expect(c).toMatchObject({ status: "ok", pending: 1 });
  });

  it("drafts that need a person (flagged for review, or parked by the send step) stay untouched in Gmail but are not part of the ELIGIBLE count: they are reported separately", async () => {
    const c = await countPendingGmailDrafts(ports([
      ...ledgerDrafts("anni", 2),
      ...ledgerDrafts("rishii", 3, "review: company research unavailable"),
      ...ledgerDrafts("lukky", 1, "attached: Lakshya_SDE.pdf; parked: opted out (asked not to be contacted)").map((d) => ({ ...d, gmailDraftId: "lukky-parked" })),
    ]));
    expect(c).toMatchObject({ status: "ok", pending: 2, byMember: { anni: 2, lukky: 0, rishii: 0 }, parked: 4 });
  });

  it("existing (old) drafts are counted like new ones, and one that is later classified as unsendable leaves the eligible count without leaving Gmail", async () => {
    const old = ledgerDrafts("anni", 150);
    expect((await createBacklogGate({ ports: ports(old) }).check("anni")).allowed).toBe(false);
    const classified = old.map((d, i) => (i < 60 ? { ...d, detail: "parked: resume is missing" } : d));
    expect(await createBacklogGate({ ports: ports(classified) }).check("anni")).toMatchObject({ allowed: true, pending: 90 });
  });

  it("a member whose Gmail is not connected cannot be looked at: their ledger drafts are counted (conservative)", async () => {
    const c = await countPendingGmailDrafts(ports([...ledgerDrafts("anni", 4), ...ledgerDrafts("lukky", 7)], { lukky: { status: "not_connected" } }));
    expect(c).toMatchObject({ status: "ok", byMember: { anni: 4, lukky: 7, rishii: 0 } });
  });

  it("cannot be counted -> unknown (never 'zero'), PER MEMBER: an unavailable or throwing Gmail makes only that member unknown; an unreadable ledger or no countable member makes it all unknown", async () => {
    const some = ledgerDrafts("anni", 2);
    const r = await countPendingGmailDrafts(ports(some, { rishii: { status: "unavailable", reason: "Gmail answered 500" } }));
    expect(r).toMatchObject({ status: "ok", pending: 2, byMember: { anni: 2, lukky: 0 } });
    expect(r.status === "ok" && r.unknown.rishii).toMatch(/Gmail answered 500/);
    const t = await countPendingGmailDrafts(ports(some, { lukky: "throw" }));
    expect(t.status === "ok" && Object.keys(t.unknown)).toEqual(["lukky"]);
    const broken: BacklogPorts = { ledgerPending: async () => { throw new Error("sheets down"); }, gmailDraftIds: async () => ({ status: "ok", ids: new Set() }) };
    expect(await countPendingGmailDrafts(broken)).toMatchObject({ status: "unknown" });
    const allDown: BacklogPorts = { ledgerPending: async () => some, gmailDraftIds: async () => ({ status: "unavailable", reason: "429" }) };
    expect(await countPendingGmailDrafts(allDown)).toMatchObject({ status: "unknown" });
  });
});

describe("the gate, PER MEMBER: 99 in a member's own Gmail drafting proceeds for them, 100 or more it pauses only them", () => {
  const gateWith = (pending: number, opts: { ttlMs?: number; now?: () => number } = {}) => {
    const p = ports([...ledgerDrafts("anni", Math.ceil(pending / 3)), ...ledgerDrafts("lukky", Math.ceil(pending / 3)), ...ledgerDrafts("rishii", pending - 2 * Math.ceil(pending / 3))]);
    return { p, gate: createBacklogGate({ ports: p, ...opts }) };
  };
  const gateFor = (counts: Partial<Record<MemberId, number>>, opts: { ttlMs?: number; now?: () => number } = {}) => {
    const p = ports(MEMBERS3.flatMap((m) => ledgerDrafts(m, counts[m] ?? 0)));
    return { p, gate: createBacklogGate({ ports: p, ...opts }) };
  };

  it("the limit is per Gmail account, not combined: 100 + 40 + 100 -> Anni and Rishii paused, Lukky drafts", async () => {
    const { gate } = gateFor({ anni: 100, lukky: 40, rishii: 100 });
    expect(await gate.check("anni")).toMatchObject({ allowed: false, pending: 100 });
    expect(await gate.check("lukky")).toMatchObject({ allowed: true, pending: 40 });
    expect(await gate.check("rishii")).toMatchObject({ allowed: false, pending: 100 });
    expect(await gate.check()).toMatchObject({ allowed: true, pending: 240 }); // "may anyone draft": yes, Lukky
  });

  it("a combined 297 (99 each) does not pause anyone", async () => {
    const { gate } = gateFor({ anni: 99, lukky: 99, rishii: 99 });
    for (const m of MEMBERS3) expect(await gate.check(m), m).toMatchObject({ allowed: true, pending: 99 });
  });

  it("0 and 99 pending in total -> allowed", async () => {
    expect(await gateWith(0).gate.check()).toMatchObject({ allowed: true, pending: 0 });
    expect(await gateWith(99).gate.check()).toMatchObject({ allowed: true, pending: 99 });
  });

  it("exactly 100 and above in ONE member's Gmail -> that member paused, with a reason that says what happens next", async () => {
    for (const n of [100, 101, 250]) {
      const { gate } = gateFor({ rishii: n });
      const v = await gate.check("rishii");
      expect(v, String(n)).toMatchObject({ allowed: false, pending: n });
      expect(v.reason).toMatch(/drafting paused for rishii/);
      expect(v.reason).toMatch(/sending continues/);
      expect((await gate.check("anni")).allowed).toBe(true);
    }
  });

  it("only when EVERY member is at the limit does check() (anyone) answer paused", async () => {
    const { gate } = gateFor({ anni: 100, lukky: 120, rishii: 100 });
    expect(await gate.check()).toMatchObject({ allowed: false });
  });

  it("drafts created meanwhile count at once, for their own member: 99 -> allowed, one more of Anni's -> Anni paused, the others not, without a new Gmail count", async () => {
    const { p, gate } = gateFor({ anni: 99 });
    expect((await gate.check("anni")).allowed).toBe(true);
    gate.noteCreated(1, "anni");
    expect(await gate.check("anni")).toMatchObject({ allowed: false, pending: 100 });
    expect(await gate.check("lukky")).toMatchObject({ allowed: true, pending: 0 });
    expect(p.listCalls()).toBe(3); // one Gmail list per member, once
  });

  it("resumes by itself once the member's real count is below 100 again (after the cached count is dropped or expires)", async () => {
    let t = 1_000_000;
    const ledger = ledgerDrafts("rishii", 120);
    const live = new Map<MemberId, Set<string>>(MEMBERS3.map((m) => [m, idsOf(ledger.filter((d) => d.memberId === m))]));
    const gate = createBacklogGate({ ports: { ledgerPending: async () => ledger, gmailDraftIds: async (m) => ({ status: "ok", ids: live.get(m)! }) }, now: () => t });
    expect((await gate.check("rishii")).allowed).toBe(false); // 120 pending
    for (const id of [...live.get("rishii")!].slice(0, 45)) live.get("rishii")!.delete(id); // 45 were sent in Gmail
    expect((await gate.check("rishii")).allowed).toBe(false); // still the cached count: a count is only trusted for a short time
    t += 31_000;
    expect(await gate.check("rishii")).toMatchObject({ allowed: true, pending: 75 });
  });

  it("invalidate() (done after the send step freed drafts) forces a fresh count", async () => {
    const ledger = [...ledgerDrafts("anni", 100)];
    const live = idsOf(ledger);
    const gate = createBacklogGate({ ports: { ledgerPending: async () => ledger, gmailDraftIds: async (m) => ({ status: "ok", ids: m === "anni" ? live : new Set() }) } });
    expect((await gate.check("anni")).allowed).toBe(false);
    live.delete("anni-0");
    gate.invalidate();
    expect(await gate.check("anni")).toMatchObject({ allowed: true, pending: 99 });
  });

  it("a count is reused only for a short time: older than the TTL it is recounted, never trusted", async () => {
    let t = 0;
    const { p, gate } = gateWith(10, { ttlMs: 30_000, now: () => t });
    await gate.check();
    await gate.check();
    expect(p.ledgerCalls()).toBe(1);
    t = 29_999;
    await gate.check();
    expect(p.ledgerCalls()).toBe(1);
    t = 30_001;
    await gate.check();
    expect(p.ledgerCalls()).toBe(2);
  });

  it("concurrent checks in one process share a single count", async () => {
    const { p, gate } = gateWith(10);
    await Promise.all([gate.check(), gate.check(), gate.check(), gate.check()]);
    expect(p.ledgerCalls()).toBe(1);
  });

  it("FAILS CLOSED, per member: if a member's Gmail cannot be read THAT member is 'paused', never 'allowed'; if the ledger cannot be read everyone is", async () => {
    const down = createBacklogGate({ ports: ports(ledgerDrafts("anni", 1), { lukky: { status: "unavailable", reason: "Gmail answered 503" } }) });
    expect(await down.check("lukky")).toMatchObject({ allowed: false, pending: null });
    expect((await down.check("lukky")).reason).toMatch(/could not be counted/);
    expect(await down.check("anni")).toMatchObject({ allowed: true, pending: 1 }); // Lukky's outage never stops Anni
    const throws = createBacklogGate({ ports: { ledgerPending: async () => { throw new Error("x"); }, gmailDraftIds: async () => ({ status: "ok", ids: new Set() }) } });
    expect(await throws.check()).toMatchObject({ allowed: false, pending: null });
  });

  it("a failed count is not remembered as success: it is retried shortly, and drafting resumes as soon as the count works", async () => {
    let t = 0;
    let healthy = false;
    const gate = createBacklogGate({ ports: { ledgerPending: async () => [], gmailDraftIds: async () => (healthy ? { status: "ok", ids: new Set() } : { status: "unavailable", reason: "timeout" }) }, now: () => t });
    expect((await gate.check()).allowed).toBe(false);
    healthy = true;
    expect((await gate.check()).allowed).toBe(false); // within the short failure memo: no hammering of Gmail
    t += 11_000;
    expect((await gate.check()).allowed).toBe(true);
  });
});

describe("the gate applies to EVERY draft-creation path, before the three-member fan-out of a Connection starts", () => {
  const closed = () => ({ check: vi.fn(async () => ({ allowed: false, pending: 130, reason: "drafting paused: 130 unsent drafts are waiting (limit 100)" })), noteCreated: vi.fn() });
  const open = () => ({ check: vi.fn(async () => ({ allowed: true, pending: 3, reason: "ok" })), noteCreated: vi.fn() });
  const target = { connectionId: "c1", name: "Jane Doe", title: "Head of Engineering", email: "jane@acme.example.com", company: { name: "Acme" } };

  it("draftForContact (Outreach imports, manual Connections and Network Finder contacts all end here): paused -> nothing composed, created or recorded", async () => {
    const mail = new MockMailboxes();
    const gate = closed();
    const research = vi.fn(async () => ({ jobs: [], status: "unavailable" as const }));
    const outcomes = await draftForContact({ config, drafts: Object.assign(mail, { backlog: gate }), research: research as never }, target);
    expect(outcomes.map((o) => o.result)).toEqual(["paused_backlog", "paused_backlog", "paused_backlog"]);
    expect(outcomes.map((o) => o.memberId)).toEqual(MEMBERS3);
    expect(mail.drafts).toEqual([]); // no draft in any mailbox
    expect(mail.rows).toEqual([]); // no ledger row (the Connection stays "needs drafts", picked up once the backlog clears)
    expect(gate.noteCreated).not.toHaveBeenCalled();
  });

  it("allowed -> one draft per member; each member's own backlog is asked, and each draft is counted for its own member", async () => {
    const mail = new MockMailboxes();
    const gate = open();
    const outcomes = await draftForContact({ config, drafts: Object.assign(mail, { backlog: gate }) }, target);
    expect(outcomes.map((o) => o.result)).toEqual(["created", "created", "created"]);
    expect(gate.check.mock.calls.map((c) => (c as unknown[])[0])).toEqual(MEMBERS3);
    expect(gate.noteCreated.mock.calls).toEqual([[1, "anni"], [1, "lukky"], [1, "rishii"]]);
  });

  it("one member at the limit is skipped; the other two still get their drafts, and the paused one is drafted later (nothing recorded for it)", async () => {
    const mail = new MockMailboxes();
    const gate = createBacklogGate({ ports: ports([...ledgerDrafts("anni", 99), ...ledgerDrafts("rishii", 100)]) });
    const deps = { config, drafts: Object.assign(mail, { backlog: gate }) };
    const first = await draftForContact(deps, target);
    expect(first.map((o) => o.result)).toEqual(["created", "created", "paused_backlog"]); // Anni 99 -> 100, Lukky, Rishii is full
    const second = await draftForContact(deps, { ...target, connectionId: "c2", email: "raj@bolt.example.com" });
    expect(second.map((o) => o.result)).toEqual(["paused_backlog", "created", "paused_backlog"]);
    expect(mail.drafts.map((d) => d.memberId)).toEqual(["anni", "lukky", "lukky"]);
    expect(mail.rows.some((r) => r.memberId === "rishii")).toBe(false);
  });

  it("a gate that throws pauses drafting (fail closed)", async () => {
    const mail = new MockMailboxes();
    const outcomes = await draftForContact({ config, drafts: Object.assign(mail, { backlog: { check: async () => { throw new Error("x"); }, noteCreated: () => undefined } }) }, target);
    expect(outcomes.every((o) => o.result === "paused_backlog")).toBe(true);
    expect(mail.drafts).toEqual([]);
  });

  it("no gate configured (tests, scripts) -> unchanged behaviour", async () => {
    const mail = new MockMailboxes();
    expect((await draftForContact({ config, drafts: mail }, target)).map((o) => o.result)).toEqual(["created", "created", "created"]);
  });

  it("createSelectionDrafts (Network Finder's selected contact): paused -> no drafts and the selection is not marked as drafted", async () => {
    const mail = new MockMailboxes();
    const put = vi.fn();
    const deps = { config, drafts: Object.assign(mail, { backlog: closed() }), selections: { put } } as unknown as PipelineDeps;
    const selection = { connectionId: "c9", contactName: "Sam Lee", email: "sam@acme.example.com", draftedFor: [] as MemberId[] } as never;
    const outcomes = await createSelectionDrafts(deps, selection, { name: "Acme" }, "Engineer");
    expect(outcomes.every((o) => o.result === "paused_backlog")).toBe(true);
    expect(mail.drafts).toEqual([]);
    expect(put).not.toHaveBeenCalled();
  });

  it("runPendingDrafts (the Outreach cycle AND the Network Finder cron): paused -> returns at once, before reading Connections, Gmail accounts or the ledger", async () => {
    const mail = new MockMailboxes();
    const list = vi.fn(async () => []);
    const isConnected = vi.spyOn(mail, "isConnected");
    const deps = { config, drafts: Object.assign(mail, { backlog: closed() }), connections: { list } } as unknown as PipelineDeps;
    const r = await runPendingDrafts(deps, { limit: 10 });
    expect(r).toMatchObject({ checked: 0, created: 0 });
    expect(r.paused).toMatch(/drafting paused/);
    expect(list).not.toHaveBeenCalled();
    expect(isConnected).not.toHaveBeenCalled();
    expect(mail.drafts).toEqual([]);
  });

  it("runPendingDrafts: when one member's gate closes during the run, only that member stops; the other members' drafts keep coming", async () => {
    const mail = new MockMailboxes();
    // Anni at 99: the first Connection takes her to 100; the next ones are drafted for Lukky and Rishii only.
    const gate = createBacklogGate({ ports: ports(ledgerDrafts("anni", 99)) });
    const recent = (i: number) => ({ connectionId: `c${i}`, memberId: "anni", name: `Person ${i}`, company: "Acme", email: `p${i}@acme.example.com`, status: "Not Connected", createdAt: new Date().toISOString(), notes: "" });
    const deps = { config, drafts: Object.assign(mail, { backlog: gate }), connections: { list: async () => [recent(1), recent(2), recent(3)] }, registry: { all: async () => [] }, runState: {} } as unknown as PipelineDeps;
    const r = await runPendingDrafts(deps, { limit: 10 });
    expect(mail.drafts.filter((d) => d.memberId === "anni")).toHaveLength(1);
    expect(mail.drafts.filter((d) => d.memberId === "lukky")).toHaveLength(3);
    expect(mail.drafts.filter((d) => d.memberId === "rishii")).toHaveLength(3);
    expect(r.created).toBe(7);
    expect(r.checked).toBe(3);
    expect(r.paused).toMatch(/drafting paused for anni/);
  });

  it("runPendingDrafts: a member already at the limit never makes a Connection that only they still need look pending; every member at the limit -> returns at once", async () => {
    const mail = new MockMailboxes();
    const gate = createBacklogGate({ ports: ports([...ledgerDrafts("anni", 100), ...ledgerDrafts("lukky", 100), ...ledgerDrafts("rishii", 100)]) });
    const list = vi.fn(async () => []);
    const r = await runPendingDrafts({ config, drafts: Object.assign(mail, { backlog: gate }), connections: { list } } as unknown as PipelineDeps, { limit: 10 });
    expect(r.paused).toMatch(/drafting paused/);
    expect(list).not.toHaveBeenCalled();
  });
});

describe("structure: no draft can be created without passing the gate", () => {
  const root = path.resolve(__dirname, "../../../src");
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []));
  const files = walk(root);
  const using = (re: RegExp) => files.filter((f) => re.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(root, f).split(path.sep).join("/")).sort();

  it("Gmail draft creation (drafts.create) is only reachable from the Network Finder draft wiring", () => {
    expect(using(/\bcreateDraftFor\b/)).toEqual(["lib/gmail/drafts.ts", "lib/network-finder/gateways.ts"]);
  });

  it("distributeDrafts (the three-member fan-out) is called from exactly one place, which hands it the gate", () => {
    expect(using(/\bdistributeDrafts\(/)).toEqual(["lib/network-finder/draft-fanout.ts", "lib/network-finder/pipeline.ts"]);
    const pipeline = fs.readFileSync(path.join(root, "lib/network-finder/pipeline.ts"), "utf8");
    expect(pipeline.match(/distributeDrafts\(/g)).toHaveLength(1);
    expect(pipeline).toMatch(/\.\.\.\(deps\.drafts!\.backlog \? \{ backlog: deps\.drafts!\.backlog \} : \{\}\)/);
  });

  it("the production wiring (used by the Outreach cycle and the Network Finder cron) always includes the gate", () => {
    const gateways = fs.readFileSync(path.join(root, "lib/network-finder/gateways.ts"), "utf8");
    expect(gateways).toMatch(/export function existingDraftDeps\(\): DraftStepDeps \{\s*return \{[\s\S]*?backlog: getDraftBacklogGate\(\)/);
    expect(using(/existingDraftDeps\(\)/).filter((f) => f !== "lib/network-finder/gateways.ts")).toEqual(["lib/network-finder/run.ts"]);
    const run = fs.readFileSync(path.join(root, "lib/network-finder/run.ts"), "utf8");
    expect(run).toContain("drafts: existingDraftDeps()");
  });

  it("the gate reads no Master Contacts (it needs only the draft ledger and the three Drafts folders)", () => {
    const code = fs.readFileSync(path.join(root, "lib/gmail/draft-backlog.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/readMaster|Master Contacts|MASTER_TAB|OutreachSheet/);
  });

  it("the gate only reads Gmail: its one Gmail call is a GET on drafts.list", () => {
    const gate = fs.readFileSync(path.join(root, "lib/gmail/draft-backlog.ts"), "utf8");
    expect((gate.match(/method: "/g) ?? [])).toEqual(['method: "']);
    expect(gate).toContain('method: "GET"');
    expect(gate).not.toMatch(/method: "(POST|PUT|PATCH|DELETE)"/);
  });
});
