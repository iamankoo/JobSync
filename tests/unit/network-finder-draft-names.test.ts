/**
 * Network Finder drafts are written and signed with each member's FULL name, and each draft still goes only to
 * that member's own Gmail (no From header, no other mailbox, never sent).
 */
import { describe, expect, it, vi } from "vitest";
import { MEMBERS, type MemberId } from "@/config/members";
import { loadNetworkFinderConfig } from "@/lib/network-finder/config";
import { distributeDrafts, type FanoutDeps } from "@/lib/network-finder/draft-fanout";
import { draftForContact, type PipelineDeps } from "@/lib/network-finder/pipeline";
import type { Brain } from "@/lib/network-finder/providers/brain";
import type { FetchLike } from "@/lib/network-finder/providers/apollo";
import { createNemotronBrain } from "@/lib/network-finder/providers/nemotron";

const FULL: Record<MemberId, string> = { anni: "Aniket Raj", lukky: "Lakshya Singh", rishii: "Rishi Raj" };

/** Draft step deps that record every draft per mailbox (all three connected, empty ledger). */
function mailboxes() {
  const sent: { memberId: MemberId; to?: string; subject: string; body: string }[] = [];
  const deps: Omit<FanoutDeps, "compose"> = {
    createDraft: async (memberId, msg) => {
      sent.push({ memberId, ...msg });
      return { status: "created", draftId: `d-${sent.length}` };
    },
    isConnected: async () => true,
    ledger: { get: async () => undefined, record: async () => undefined },
  };
  return { sent, deps };
}

const target = { connectionId: "conn_priya", name: "Priya Sharma", title: "Engineering Manager", email: "priya@acme.example", company: { name: "Acme", website: "https://acme.example" } };

function pipelineDeps(brain: Brain | undefined, drafts: Omit<FanoutDeps, "compose">, signatures: Partial<Record<MemberId, string>> = {}): PipelineDeps {
  return { config: { ...loadNetworkFinderConfig({ NETWORK_FINDER_ENABLED: "true" } as unknown as NodeJS.ProcessEnv), signatures }, ...(brain ? { brain } : {}), drafts } as unknown as PipelineDeps;
}

describe("member full names", () => {
  it("maps Anni → Aniket Raj, Lukky → Lakshya Singh, Rishii → Rishi Raj (app names unchanged)", () => {
    expect(MEMBERS.map((m) => [m.id, m.name, m.fullName])).toEqual([
      ["anni", "Anni", "Aniket Raj"],
      ["lukky", "Lukky", "Lakshya Singh"],
      ["rishii", "Rishii", "Rishi Raj"],
    ]);
  });

  it("the fan-out composes each member's draft with THEIR full name and creates it only in THEIR mailbox", async () => {
    const { sent, deps } = mailboxes();
    const compose = vi.fn(async (_m: MemberId, name: string) => ({ subject: `Hello from ${name}`, body: `Hi Priya,\n\nBest regards,\n${name}` }));
    await distributeDrafts({ type: "contact", id: "conn_priya", to: "priya@acme.example" }, { ...deps, compose });
    expect(compose.mock.calls).toEqual([["anni", "Aniket Raj"], ["lukky", "Lakshya Singh"], ["rishii", "Rishi Raj"]]);
    for (const m of ["anni", "lukky", "rishii"] as const) {
      const mine = sent.filter((s) => s.memberId === m);
      expect(mine).toHaveLength(1);
      expect(mine[0].subject).toBe(`Hello from ${FULL[m]}`);
      // No other member's name in this mailbox's draft.
      for (const other of Object.values(FULL).filter((n) => n !== FULL[m])) expect(mine[0].body).not.toContain(other);
    }
  });
});

describe("draft text and sign-off", () => {
  it("the built-in writer introduces and signs off with the full name, then the member's own signature", async () => {
    const { sent, deps } = mailboxes();
    await draftForContact(pipelineDeps(undefined, deps, { lukky: "Lakshya | linkedin.example/lakshya" }), target);
    for (const m of ["anni", "lukky", "rishii"] as const) {
      const body = sent.find((s) => s.memberId === m)!.body;
      expect(body).toContain(`I'm ${FULL[m]}`);
      expect(body).toMatch(new RegExp(`Best regards,\\n${FULL[m]}($|\\n\\n-- \\n)`));
      expect(body).not.toMatch(/\b(Anni|Lukky|Rishii)\b/);
    }
    expect(sent.find((s) => s.memberId === "lukky")!.body.endsWith("Best regards,\nLakshya Singh\n\n-- \nLakshya | linkedin.example/lakshya")).toBe(true);
  });

  it("adds the full-name sign-off when the writer leaves it out, and never duplicates one that is there", async () => {
    const noSignOff: Brain = { id: "test", prioritizeCompanies: async (c) => [...c], choosePeople: async (_c, p) => [...p], isRelevantJob: async () => ({ relevant: true, reason: "" }), writeDraft: async (r) => ({ subject: "Hi", body: `Hi Priya,\n\nI'm ${r.member.name} and I admire Acme.` }) };
    const a = mailboxes();
    await draftForContact(pipelineDeps(noSignOff, a.deps), target);
    for (const m of ["anni", "lukky", "rishii"] as const) expect(a.sent.find((s) => s.memberId === m)!.body.endsWith(`\n\nBest regards,\n${FULL[m]}`)).toBe(true);

    const signs: Brain = { ...noSignOff, writeDraft: async (r) => ({ subject: "Hi", body: `Hi Priya,\n\nThanks!\n\nWarm regards,\n${r.member.name}` }) };
    const b = mailboxes();
    await draftForContact(pipelineDeps(signs, b.deps), target);
    for (const m of ["anni", "lukky", "rishii"] as const) {
      const body = b.sent.find((s) => s.memberId === m)!.body;
      expect(body.endsWith(`Warm regards,\n${FULL[m]}`)).toBe(true);
      expect(body.split(FULL[m]).length - 1).toBe(1);
    }
  });

  it("Nemotron receives only the full name (and profile), never the app id or nickname", async () => {
    const fetchFn = vi.fn<FetchLike>(async () => Response.json({ choices: [{ message: { content: '{"subject":"Hello","body":"Hi Priya,\\n\\nBest regards,\\nAniket Raj"}' } }] }));
    const brain = createNemotronBrain({ apiKey: "nv-test", model: "m", baseUrl: "https://nim.example.test/v1", minIntervalMs: 0 } as Parameters<typeof createNemotronBrain>[0], fetchFn);
    await brain.writeDraft({ kind: "outreach", member: { id: "anni", name: "Aniket Raj", profile: "CS student" }, company: { name: "Acme" }, person: { name: "Priya Sharma", title: "Engineering Manager" } });
    const sentToModel = String(fetchFn.mock.calls[0][1]?.body);
    expect(sentToModel).toContain("Aniket Raj");
    expect(sentToModel).toContain("CS student");
    expect(sentToModel).not.toMatch(/\banni\b/i);
    expect(sentToModel).toMatch(/signed with exactly member\.name/);
  });
});
