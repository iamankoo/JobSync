/**
 * REGRESSION (29–31 Oct): every scheduled call was slow because it read the same Sheets tabs many times (two drafting
 * passes, the discovery batch, an unconditional Jobs read), so Sheets rate-limited (429) and the job search — which ran last —
 * was rarely reached. A quiet cycle (nothing to draft, nothing found) must stay within a small read budget and must reach the job search.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSheetsClientForTesting, type SheetsClient } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { invalidateTableCache } from "@/lib/google-sheets/table";
import { loadNetworkFinderConfig } from "@/lib/network-finder/config";
import { existingConnections, existingDraftDeps, existingJobs } from "@/lib/network-finder/gateways";
import { runScheduledCycle, summarizeCycle } from "@/lib/network-finder/run";
import { createSheetsStores } from "@/lib/network-finder/sheets-stores";
import { MockJobSource } from "../helpers/network-finder-mocks";
import { FakeSheets } from "../helpers/fake-sheets";

let sheets: FakeSheets;
beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  resetMembersCache();
  invalidateTableCache();
});
afterEach(() => setSheetsClientForTesting(null));

function counted() {
  const reads: string[] = [];
  const client: SheetsClient = {
    getValues: async (range) => (reads.push(range.split("!")[0]), sheets.getValues(range)),
    appendValues: (r, rows) => sheets.appendValues(r, rows),
    updateValues: (r, rows) => sheets.updateValues(r, rows),
    deleteRows: (t, rows) => sheets.deleteRows(t, rows),
  };
  setSheetsClientForTesting(client);
  return reads;
}

describe("a quiet scheduled cycle", () => {
  it("reads each tab at most twice, never discovers connections, and still reaches the daily job search", async () => {
    const reads = counted();
    const stores = createSheetsStores();
    const jobSource = new MockJobSource();
    const result = await runScheduledCycle(
      {
        config: loadNetworkFinderConfig({ NETWORK_FINDER_ENABLED: "true", APP_TIMEZONE: "Asia/Kolkata" } as unknown as NodeJS.ProcessEnv),
        sources: [], jobSources: [jobSource], seedBoards: [{ name: "Acme", ats: "greenhouse", token: "acme" }],
        queue: stores.queue, registry: stores.registry, ledger: stores.ledger, selections: stores.selections,
        drafts: existingDraftDeps(), connections: existingConnections, jobs: existingJobs, runState: {}, stores,
      },
      50_000,
    );
    expect(result.errors).toEqual([]);
    expect(result.batch).toEqual({ ran: false, reason: "discovery_off" });
    // the job search ran (both kinds) and was given the seeded board
    expect(jobSource.searches.map((q) => q.employment).sort()).toEqual(["full_time", "internship"]);
    expect(summarizeCycle(result).dailyJobs).toMatchObject({ internships: 0, fullTime: 0 });
    // read budget
    const perTab = reads.reduce<Record<string, number>>((m, t) => ({ ...m, [t]: (m[t] ?? 0) + 1 }), {});
    expect(perTab, JSON.stringify(perTab)).toSatisfy((p: Record<string, number>) => Math.max(...Object.values(p)) <= 2);
    expect(reads.length).toBeLessThanOrEqual(12);
    expect(perTab.Jobs ?? 0).toBe(0); // nothing qualified, so the Jobs sheet was not read at all
  });
});
