/**
 * The ten-minute drafting delay and the per-member queues (mock Gmail, in-memory ledger; nothing is sent).
 *  - A new manual OR imported Connection gets no draft at once: its three member drafts become eligible DRAFT_DELAY_MS after its saved CreatedAt.
 *    The delay is derived from the Connection row itself (durable), so a restarted runner or a later cron call sees exactly the same thing.
 *  - Repeated runs never create a second draft; a delayed Connection never blocks older eligible ones, and one member's full backlog never
 *    blocks the other members.
 */
import { describe, expect, it } from "vitest";
import type { MemberId } from "@/config/members";
import { createBacklogGate, type PendingLedgerDraft } from "@/lib/gmail/draft-backlog";
import { loadNetworkFinderConfig } from "@/lib/network-finder/config";
import { DRAFT_DELAY_MS, runPendingDrafts, type PipelineDeps } from "@/lib/network-finder/pipeline";
import { MockMailboxes } from "../../helpers/network-finder-mocks";

const T0 = Date.parse("2026-11-14T10:00:00.000Z");
const MIN = 60_000;

const conn = (id: string, createdAtMs: number, extra: Record<string, unknown> = {}) => ({
  connectionId: id, memberId: "lukky", name: `Person ${id}`, company: "Acme", email: `${id}@acme.example.com`, status: "Not Connected",
  createdAt: new Date(createdAtMs).toISOString(), notes: "", ...extra,
});

function worker(list: ReturnType<typeof conn>[], clock: { t: number }, opts: { env?: Record<string, string>; backlog?: ReturnType<typeof createBacklogGate>; limit?: number } = {}) {
  const mail = new MockMailboxes();
  const config = loadNetworkFinderConfig({ NETWORK_FINDER_ENABLED: "true", ...(opts.env ?? {}) } as unknown as NodeJS.ProcessEnv);
  const deps = {
    config,
    drafts: Object.assign(mail, opts.backlog ? { backlog: opts.backlog } : {}),
    connections: { list: async () => list },
    registry: { all: async () => [] },
    runState: {},
    now: () => new Date(clock.t),
  } as unknown as PipelineDeps;
  return { mail, run: () => runPendingDrafts(deps, { limit: opts.limit ?? 10 }) };
}

describe("ten-minute drafting delay", () => {
  it("is 10 minutes, and is the production default (DRAFT_DELAY_MINUTES unset)", () => {
    expect(DRAFT_DELAY_MS).toBe(10 * MIN);
    expect(loadNetworkFinderConfig({} as unknown as NodeJS.ProcessEnv).draftDelayMs).toBe(10 * MIN);
    expect(loadNetworkFinderConfig({ DRAFT_DELAY_MINUTES: "0" } as unknown as NodeJS.ProcessEnv).draftDelayMs).toBe(0);
    expect(loadNetworkFinderConfig({ DRAFT_DELAY_MINUTES: "nonsense" } as unknown as NodeJS.ProcessEnv).draftDelayMs).toBe(10 * MIN);
  });

  it("a manually added Connection: no draft at 0 or 9 minutes; at 10 minutes one personalised draft in EACH member's own mailbox; never twice", async () => {
    const clock = { t: T0 };
    const w = worker([conn("m1", T0)], clock);
    expect(await w.run()).toMatchObject({ created: 0 });
    clock.t = T0 + 9 * MIN + 59_000;
    expect(await w.run()).toMatchObject({ created: 0 });
    expect(w.mail.drafts).toEqual([]);
    clock.t = T0 + 10 * MIN;
    expect(await w.run()).toMatchObject({ created: 3 });
    expect(w.mail.drafts.map((d) => d.memberId).sort()).toEqual(["anni", "lukky", "rishii"]);
    for (const d of w.mail.drafts) expect(d.to).toBe("m1@acme.example.com");
    // repeated cron runs (and a restarted runner: the state is only the Connection row and the ledger) add nothing
    clock.t += 5 * MIN;
    await w.run();
    await w.run();
    expect(w.mail.drafts).toHaveLength(3);
  });

  it("an IMPORTED Connection (Outreach Database) waits exactly the same 10 minutes", async () => {
    const clock = { t: T0 + 5 * MIN };
    const imported = conn("i1", T0, { notes: "Company description (from the company's website): Acme builds rockets." });
    const w = worker([imported], clock);
    expect(await w.run()).toMatchObject({ created: 0 });
    clock.t = T0 + 10 * MIN;
    expect(await w.run()).toMatchObject({ created: 3 });
  });

  it("Connections a member added by hand are drafted BEFORE older JobSync-imported ones (oldest first within each group)", async () => {
    const clock = { t: T0 + 60 * MIN };
    const imported = (id: string, at: number) => conn(id, at, { notes: `Source: Outreach Database c_${id}` });
    const w = worker([imported("imp1", T0), imported("imp2", T0 + MIN), conn("man2", T0 + 20 * MIN), conn("man1", T0 + 10 * MIN)], clock, { limit: 1 });
    const order: string[] = [];
    for (let k = 0; k < 4; k++) {
      const before = w.mail.drafts.length;
      await w.run();
      order.push(w.mail.drafts[before]!.to!.split("@")[0]);
    }
    expect(order).toEqual(["man1", "man2", "imp1", "imp2"]);
  });

  it("a delayed (too new) Connection never blocks older ones that are already eligible", async () => {
    const clock = { t: T0 + 30 * MIN };
    const w = worker([conn("new", T0 + 29 * MIN), conn("old", T0)], clock);
    const r = await w.run();
    expect(r).toMatchObject({ created: 3 });
    expect(new Set(w.mail.drafts.map((d) => d.to))).toEqual(new Set(["old@acme.example.com"]));
  });

  it("a member whose Gmail is temporarily unavailable: the others get their drafts; that member's stays pending and is drafted on a later run", async () => {
    const clock = { t: T0 + 11 * MIN };
    const w = worker([conn("m2", T0)], clock);
    w.mail.failFor.add("rishii");
    const first = await w.run();
    expect(first.created).toBe(2);
    expect(w.mail.rows.find((r) => r.memberId === "rishii")?.status).toBe("failed");
    w.mail.failFor.clear();
    await w.run();
    expect(w.mail.drafts.map((d) => d.memberId).sort()).toEqual(["anni", "lukky", "rishii"]);
    await w.run();
    expect(w.mail.drafts).toHaveLength(3);
  });
});

describe("per-member queues: one member's 100 drafts never stop the others", () => {
  const ledger = (member: MemberId, n: number): PendingLedgerDraft[] => Array.from({ length: n }, (_, i) => ({ memberId: member, gmailDraftId: `${member}-${i}`, detail: "" }));

  it("Anni 100, Lukky 40, Rishii 100 -> new Connections are drafted for Lukky only; Anni and Rishii resume once below 100", async () => {
    const live: Record<MemberId, PendingLedgerDraft[]> = { anni: ledger("anni", 100), lukky: ledger("lukky", 40), rishii: ledger("rishii", 100) };
    const gate = createBacklogGate({
      ports: {
        ledgerPending: async () => [...live.anni, ...live.lukky, ...live.rishii],
        gmailDraftIds: async (m) => ({ status: "ok", ids: new Set(live[m].map((d) => d.gmailDraftId)) }),
      },
      ttlMs: 0,
    });
    const clock = { t: T0 + 20 * MIN };
    const w = worker([conn("a", T0), conn("b", T0 + MIN)], clock, { backlog: gate });
    const first = await w.run();
    expect(first.created).toBe(2);
    expect(first.paused).toMatch(/anni/);
    expect(first.paused).toMatch(/rishii/);
    expect(w.mail.drafts.every((d) => d.memberId === "lukky")).toBe(true);

    // Anni's backlog is sent down to 99 (Rishii is still full): Anni's drafts of both Connections follow, Lukky's are not repeated
    live.anni = live.anni.slice(0, 97);
    await w.run();
    expect(w.mail.drafts.filter((d) => d.memberId === "anni")).toHaveLength(2);
    expect(w.mail.drafts.filter((d) => d.memberId === "lukky")).toHaveLength(2);
    expect(w.mail.drafts.filter((d) => d.memberId === "rishii")).toHaveLength(0);

    live.rishii = [];
    await w.run();
    expect(w.mail.drafts.filter((d) => d.memberId === "rishii")).toHaveLength(2);
    expect(w.mail.drafts).toHaveLength(6); // each member exactly one draft per Connection
  });
});
