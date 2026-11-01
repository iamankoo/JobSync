import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireSafeTestEnv } from "../helpers/live-env";
import { openTestSheet } from "../helpers/live-sheets";
import type { JobCandidate } from "@/lib/network-finder/types";

/**
 * LIVE (disposable TEST spreadsheet only): the progressive-window job search on the REAL Google Sheets API — real Jobs service,
 * real NF_State ledger/notes. Proves the window cursor, the day's funnel and the per-kind counters survive a restart ("a new
 * process"), that nothing is duplicated, and the run only ever holds the TEST sheet id (no production read or write). Job listings are synthetic.
 */
const env = (() => requireSafeTestEnv())();
// A unique day per run, so state left in NF_State by an earlier run can never leak into this one.
const NOON = Date.UTC(2030, 0, 1, 6, 30) + Math.floor(Math.random() * 3000) * 86_400_000;
const DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(NOON));
let sheet: ReturnType<typeof openTestSheet>;

beforeAll(async () => {
  process.env.GOOGLE_SHEETS_SPREADSHEET_ID = env.testId;
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = env.email;
  process.env.GOOGLE_PRIVATE_KEY = env.privateKey;
  process.env.SHEETS_CACHE_TTL_MS = "0";
  delete process.env.SHEETS_TEST_BACKEND;
  sheet = openTestSheet();
  expect(await sheet.title()).toMatch(/^JobSync TEST/);
  await sheet.reset();
  await ensureNfStateTab();
}, 120_000);

afterAll(async () => {
  await sheet?.reset();
}, 120_000);

/** The test sheet has no NF_State tab (the Network Finder tabs exist only in production); add it HERE, never anywhere else. */
async function ensureNfStateTab() {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { auth, sheets } = require("@googleapis/sheets");
  const key = env.privateKey.replace(/\n/g, String.fromCharCode(10));
  const api = sheets({ version: "v4", auth: new auth.JWT({ email: env.email, key, scopes: ["https://www.googleapis.com/auth/spreadsheets"] }) });
  expect(env.testId).not.toBe(env.prodId);
  const meta = await api.spreadsheets.get({ spreadsheetId: env.testId, fields: "sheets.properties.title" });
  if ((meta.data.sheets ?? []).some((s: { properties?: { title?: string } }) => s.properties?.title === "NF_State")) return;
  await api.spreadsheets.batchUpdate({ spreadsheetId: env.testId, requestBody: { requests: [{ addSheet: { properties: { title: "NF_State" } } }] } });
  await api.spreadsheets.values.update({ spreadsheetId: env.testId, range: "NF_State!A1:C1", valueInputOption: "RAW", requestBody: { values: [["Key", "Value", "UpdatedAt"]] } });
}

const synthetic = (kind: "internship" | "full_time", ageDays: number, n: number, region: "IN" | "OTHER" = "OTHER"): JobCandidate => ({
  source: "Greenhouse", companyName: `[LIVE TEST] Co ${kind}-${ageDays}-${n}`, title: kind === "internship" ? "Full Stack Engineering Intern" : "Full Stack Engineer, New Grad",
  url: `https://boards.greenhouse.io/livetest/jobs/${kind}-${ageDays}-${n}`, location: region === "IN" ? "Bengaluru, India" : "Remote - Worldwide, Germany", remote: region !== "IN",
  workplace: region === "IN" ? "hybrid" : "remote", postedAt: new Date(NOON - ageDays * 86_400_000).toISOString(),
  description: "New grads welcome. B.Tech / B.E. students graduating in 2027. React and Node.js.",
  salary: kind === "internship" ? { max: 80_000, currency: "INR", period: "month" } : { max: 1_800_000, currency: "INR", period: "year" },
  ...(kind === "internship" ? { employment: "internship" as const } : {}),
});

describe("progressive windows on the real Sheets API (test spreadsheet)", () => {
  it("window 1 saves only fresh jobs; the next scan (a NEW process) opens window 2 from the stored cursor and saves only what is still needed", async () => {
    const { loadNetworkFinderConfig } = await import("@/lib/network-finder/config");
    const { existingConnections, existingJobs } = await import("@/lib/network-finder/gateways");
    const { runDailyJobSearch } = await import("@/lib/network-finder/pipeline");
    const { createSheetsStores } = await import("@/lib/network-finder/sheets-stores");
    const { InMemoryQueue } = await import("@/lib/network-finder/queue");
    const { InMemoryCompanyRegistry } = await import("@/lib/network-finder/registry");
    const { MockJobSource } = await import("../helpers/network-finder-mocks");

    const process_ = () => {
      const stores = createSheetsStores(); // a fresh "process": nothing cached in memory
      const source = new MockJobSource();
      source.searchResults = [
        ...[0, 1, 2, 3, 4].map((n) => synthetic("full_time", 3, n, n < 2 ? "IN" : "OTHER")), // window 1: 2 India + 3 worldwide
        ...[0, 1, 2, 3, 4, 5, 6, 7].map((n) => synthetic("full_time", 12, n, n < 2 ? "IN" : "OTHER")), // window 2: 2 India + 6 worldwide
        ...[0, 1].map((n) => synthetic("full_time", 25, n, n < 1 ? "IN" : "OTHER")), // window 3: 1 India + 1 worldwide
      ];
      return {
        source,
        deps: {
          config: loadNetworkFinderConfig({ NETWORK_FINDER_ENABLED: "true", APP_TIMEZONE: "Asia/Kolkata" } as unknown as NodeJS.ProcessEnv),
          sources: [], jobSources: [source], seedBoards: Array.from({ length: 12 }, (_, i) => ({ name: `Board ${i}`, ats: "greenhouse" as const, token: `live${i}` })),
          queue: new InMemoryQueue() as never, registry: new InMemoryCompanyRegistry(), ledger: stores.ledger, selections: stores.selections,
          connections: existingConnections, jobs: existingJobs, now: () => new Date(NOON),
        },
        stores,
      };
    };

    const first = process_();
    const r1 = await runDailyJobSearch(first.deps);
    expect(r1.report!.full_time).toMatchObject({ eligible: 15, deferred: 10, window: 2 });
    expect(r1.report!.full_time.saved).toHaveLength(5);
    expect(await first.stores.ledger.get(`${DAY}#jobs-full-time`)).toBe(5);

    const second = process_(); // restart: only the sheet remembers
    const r2 = await runDailyJobSearch(second.deps);
    expect(r2.report!.full_time.saved).toHaveLength(8); // window 2 only: the window-3 jobs wait for their window
    expect(r2.report!.full_time.byWindow[2].saved).toBe(8);
    expect(r2.report!.full_time.byWindow[3]?.saved ?? 0).toBe(0);
    expect(await second.stores.ledger.get(`${DAY}#jobs-full-time`)).toBe(13);

    const third = process_();
    const r3 = await runDailyJobSearch(third.deps);
    expect(r3.report!.full_time.saved).toHaveLength(2); // exactly the 2 still needed, from window 3
    expect(await third.stores.ledger.get(`${DAY}#jobs-full-time`)).toBe(15);
    const fourth = process_();
    await runDailyJobSearch(fourth.deps);
    expect(fourth.source.searches.filter((q) => q.employment === "full_time")).toHaveLength(0); // done for the day: not searched

    const rows = await sheet.dataRows("Jobs");
    expect(rows).toHaveLength(15);
    expect(new Set(rows.map((r) => r[8])).size).toBe(15); // no duplicate links
    const members = rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r[11]]: (m[r[11]] ?? 0) + 1 }), {});
    expect(members).toEqual({ anni: 5, lukky: 5, rishii: 5 });
  }, 280_000);
});
