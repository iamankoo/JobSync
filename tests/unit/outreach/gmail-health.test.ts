import { describe, expect, it } from "vitest";
import { classify, runGmailHealth, type AccountHealth } from "@/lib/outreach/gmail-health";
import type { MemberId } from "@/config/members";

const NOW = new Date("2026-11-11T05:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const acct = (memberId: MemberId, status: AccountHealth["status"], ageDays: number): AccountHealth => ({ memberId, status, connectedAt: daysAgo(ageDays) });

function harness(accounts: AccountHealth[], opts: { verdict?: "done" | "retry" } = {}) {
  const claimed = new Set<string>();
  const sent: { member: MemberId; tag: string }[] = [];
  const deps = {
    sheet: {
      claimedMilestones: async () => new Set(claimed),
      claimMilestone: async (k: string) => (claimed.has(k) ? false : (claimed.add(k), true)),
      completeMilestone: async () => undefined,
      releaseMilestone: async (k: string) => { claimed.delete(k); },
    },
    accounts: async () => accounts,
    notifyMember: async (member: MemberId, p: { tag: string }) => {
      if (opts.verdict === "retry") return "retry" as const;
      sent.push({ member, tag: p.tag });
      return "done" as const;
    },
    now: () => NOW,
    timezone: "Asia/Kolkata",
  };
  return { deps, sent, claimed };
}

describe("Gmail health alerts", () => {
  it("classifies lapsed, expiring (6 to <8 days) and healthy", () => {
    expect(classify(acct("anni", "reauth_required", 1), NOW)).toBe("lapsed");
    expect(classify(acct("anni", "disconnected", 1), NOW)).toBe("lapsed");
    expect(classify(acct("anni", "connected", 5.9), NOW)).toBeNull();
    expect(classify(acct("anni", "connected", 6.5), NOW)).toBe("expiring");
    expect(classify(acct("anni", "connected", 8.1), NOW)).toBeNull();
  });

  it("alerts only the affected member, once per day", async () => {
    const h = harness([acct("anni", "connected", 6.5), acct("lukky", "connected", 0.5), acct("rishii", "reauth_required", 3)]);
    const r1 = await runGmailHealth(h.deps);
    expect(r1).toEqual({ lapsed: ["rishii"], expiring: ["anni"], alerted: 2 });
    expect(h.sent.map((s) => s.member).sort()).toEqual(["anni", "rishii"]);
    const r2 = await runGmailHealth(h.deps); // same day, next cron call
    expect(r2.alerted).toBe(0);
    expect(h.sent).toHaveLength(2);
  });

  it("a push that cannot be delivered is retried on a later pass (claim released)", async () => {
    const h = harness([acct("lukky", "reauth_required", 1)], { verdict: "retry" });
    expect((await runGmailHealth(h.deps)).alerted).toBe(0);
    expect(h.claimed.size).toBe(0);
  });

  it("sends nothing when everyone is healthy", async () => {
    const h = harness([acct("anni", "connected", 2), acct("lukky", "connected", 2), acct("rishii", "connected", 2)]);
    expect((await runGmailHealth(h.deps)).alerted).toBe(0);
  });
});
