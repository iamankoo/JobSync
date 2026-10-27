/**
 * Network Finder drafts are written and signed with each member's FULL name, and each draft still goes only to
 * that member's own Gmail (no From header, no other mailbox, never sent).
 */
import { describe, expect, it, vi } from "vitest";
import { MEMBERS, type MemberId } from "@/config/members";
import { buildEmailPlan } from "@/lib/network-finder/email-composer";
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
  it("each draft greets the recipient, is signed ONCE with the full name + that member's links, then the optional extra signature", async () => {
    const { sent, deps } = mailboxes();
    await draftForContact(pipelineDeps(undefined, deps, { lukky: "Lakshya | linkedin.example/lakshya" }), target);
    for (const m of ["anni", "lukky", "rishii"] as const) {
      const body = sent.find((s) => s.memberId === m)!.body;
      const me = MEMBERS.find((x) => x.id === m)!;
      expect(body.startsWith("Dear Priya,")).toBe(true);
      expect(body).toContain(`Best regards,\n${FULL[m]}\nLinkedIn: ${me.linkedinUrl}\nGitHub: ${me.githubUrl}`);
      expect(body.split("Best regards,").length - 1).toBe(1);
      expect(body).not.toMatch(/\b(Anni|Lukky|Rishii)\b/);
      for (const other of MEMBERS.filter((x) => x.id !== m)) for (const v of [other.fullName, other.linkedinUrl, other.githubUrl]) expect(body).not.toContain(v);
    }
    expect(sent.find((s) => s.memberId === "lukky")!.body.endsWith("GitHub: https://github.com/lukkydiwan\n\n-- \nLakshya | linkedin.example/lakshya")).toBe(true);
  });

  it("a writer's own sign-off is replaced (never duplicated), and an invalid AI draft falls back to the verified template", async () => {
    const base: Brain = { id: "test", prioritizeCompanies: async (c) => [...c], choosePeople: async (_c, p) => [...p], isRelevantJob: async () => ({ relevant: true, reason: "" }), writeDraft: async () => ({ subject: "x", body: "" }) };
    // Signs off by itself and is too short → validation fails → deterministic template fill, signed once.
    const signs: Brain = { ...base, writeDraft: async (r) => ({ subject: "Hi", body: `Hi Priya,\n\nThanks!\n\nWarm regards,\n${r.member.name}` }) };
    const b = mailboxes();
    await draftForContact(pipelineDeps(signs, b.deps), target);
    for (const m of ["anni", "lukky", "rishii"] as const) {
      const body = b.sent.find((s) => s.memberId === m)!.body;
      expect(body).not.toContain("Warm regards");
      expect(body.split(FULL[m]).length - 1).toBe(1);
      expect(body).toContain("I am writing to express my interest");
    }
    // Invents a skill the member does not have → rejected → template fill without it.
    const invents: Brain = { ...base, writeDraft: async () => ({ subject: "x", body: Array(6).fill("I have years of experience with Kubernetes, Golang and Rust in production systems at large companies across many teams.").join("\n\n") }) };
    const c = mailboxes();
    await draftForContact(pipelineDeps(invents, c.deps), target);
    for (const d of c.sent) expect(d.body).not.toMatch(/Kubernetes|Golang|Rust/);
  });

  it("with a plan, Nemotron gets only verified facts (full name, education, skills, projects) — never the app id — and writes paragraphs only", async () => {
    const fetchFn = vi.fn<FetchLike>(async () => Response.json({ choices: [{ message: { content: '{"paragraphs":["One.","Two.","Three.","Four."]}' } }] }));
    const brain = createNemotronBrain({ apiKey: "nv-test", model: "m", baseUrl: "https://nim.example.test/v1", minIntervalMs: 0 } as Parameters<typeof createNemotronBrain>[0], fetchFn);
    const plan = buildEmailPlan({ memberId: "anni", company: { name: "Acme" }, person: { name: "Priya Sharma" }, job: { title: "Backend Engineer" } });
    const out = await brain.writeDraft({ kind: "job_application", member: { id: "anni", name: "Aniket Raj" }, company: { name: "Acme" }, person: { name: "Priya Sharma", title: "Engineering Manager" }, plan });
    expect(out).toEqual({ subject: "Application for Backend Engineer — Acme", body: "One.\n\nTwo.\n\nThree.\n\nFour." });
    const sentToModel = String(fetchFn.mock.calls[0][1]?.body);
    expect(sentToModel).toContain("Aniket Raj");
    expect(sentToModel).toContain("Node.js");
    expect(sentToModel).not.toMatch(/\banni\b/i);
    expect(sentToModel).toMatch(/claim NO skill/);
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
