/**
 * Send order is fair across members (mock Gmail, in-memory Sheets; nothing real is sent): one member's backlog of older drafts can never keep
 * another member's drafts waiting. Production case (14 Nov): Lukky and Rishii had re-drafts of 9-Nov Connections ahead of every one of Anni's drafts.
 */
import { describe, expect, it } from "vitest";
import { runSendStep } from "@/lib/outreach/send-workflow";
import { buildSendFixture } from "../helpers/send-fixture";

const older = (n: number) => Array.from({ length: n }, (_, i) => ({ email: `old${i}@old${i}.example.com`, name: `Old Person${i}`, company: `OldCo${i}`, members: ["lukky", "rishii"] as ("lukky" | "rishii")[] }));
const newer = (n: number) => Array.from({ length: n }, (_, i) => ({ email: `new${i}@new${i}.example.com`, name: `New Person${i}`, company: `NewCo${i}`, members: ["anni"] as "anni"[] }));

describe("fair send order across members", () => {
  it("with time for only 3 sends, Anni's (newer) draft goes out alongside Lukky's and Rishii's oldest, not after all of theirs", async () => {
    const f = buildSendFixture([...older(6), ...newer(3)]);
    await f.seed();
    const deps = f.deps();
    Object.defineProperty(deps, "deadline", { get: () => (f.gmail.sentMessages.length >= 3 ? Date.now() - 1 : Date.now() + 60_000) });
    await runSendStep(deps);
    expect(f.gmail.sentMessages.map((s) => s.member).sort()).toEqual(["anni", "lukky", "rishii"]);
  }, 120_000);

  it("given time, every member's drafts are all sent, each exactly once", async () => {
    const f = buildSendFixture([...older(4), ...newer(4)]);
    await f.seed();
    const r = await runSendStep(f.deps());
    expect(r.sent).toBe(12);
    expect(new Set(f.gmail.sentMessages.map((s) => s.draftId)).size).toBe(12);
    for (const m of ["anni", "lukky", "rishii"]) expect(f.gmail.sentMessages.filter((s) => s.member === m)).toHaveLength(4);
  }, 120_000);
});
