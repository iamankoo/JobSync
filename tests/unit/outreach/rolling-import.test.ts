/**
 * The import limit is GLOBAL (all members together) over a ROLLING 24 hours: 200 shared Connections, never 200 per member and never a
 * calendar-day counter. Plus: the static Master Contacts read is cached, so cron calls do not exhaust the Sheets read quota.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { invalidateTableCache } from "@/lib/google-sheets/table";
import { runOutreachImport } from "@/lib/outreach/importer";
import { realConnectionsPort } from "@/lib/outreach/run";
import { OutreachSheet, clearMasterCache } from "@/lib/outreach/sheet";
import { FakeSheets } from "../../helpers/fake-sheets";
import { manyContacts, masterGrid, newOutreachSpreadsheet } from "../../helpers/outreach";

describe("global rolling 24-hour import limit", () => {
  let prod: FakeSheets;
  beforeEach(() => {
    prod = new FakeSheets().seedMembers();
    setSheetsClientForTesting(prod);
    resetMembersCache();
    invalidateTableCache();
  });
  afterEach(() => setSheetsClientForTesting(null));

  const at = (iso: string) => () => new Date(iso);
  const imp = (sheet: OutreachSheet, iso: string, over: { dailyLimit?: number; perRun?: number; staleClaimMs?: number } = {}) =>
    runOutreachImport({ sheet, connections: realConnectionsPort, now: at(iso), timezone: "Asia/Kolkata", dailyLimit: over.dailyLimit ?? 5, perRun: over.perRun ?? 50, ...(over.staleClaimMs !== undefined ? { staleClaimMs: over.staleClaimMs } : {}) });

  it("imports at most the limit in any rolling 24 hours (shared by all members), then continues with the NEXT contacts after the window", async () => {
    const o = newOutreachSpreadsheet(masterGrid(manyContacts(12)));
    const sheet = new OutreachSheet(o.fake);
    await sheet.ensureTabs();
    const a = await imp(sheet, "2026-11-06T17:00:00.000Z"); // 22:30 IST
    expect(a.importedThisRun).toBe(5);
    expect(a.stoppedBecause).toBe("daily-limit");
    // 19:00 UTC = 00:30 IST: a new CALENDAR day, but only 2 hours later -> still nothing
    expect((await imp(sheet, "2026-11-06T19:00:00.000Z")).importedThisRun).toBe(0);
    expect((await imp(sheet, "2026-11-07T16:59:00.000Z")).importedThisRun).toBe(0); // 23h59m after the first claim
    const b = await imp(sheet, "2026-11-07T17:01:00.000Z"); // just over 24h
    expect(b.importedThisRun).toBe(5);
    expect(prod.dataRows("Connections")).toHaveLength(10);
    expect(new Set(prod.dataRows("Connections").map((c) => c[12])).size).toBe(10); // 10 unique shared Connections, no duplicates
    // the next batch continues with different contacts
    expect((await imp(sheet, "2026-11-08T18:00:00.000Z")).importedThisRun).toBe(2);
  });

  it("the limit is shared across members: ownership rotates among all three but the total never exceeds the limit", async () => {
    const o = newOutreachSpreadsheet(masterGrid(manyContacts(9)));
    const sheet = new OutreachSheet(o.fake);
    await sheet.ensureTabs();
    await imp(sheet, "2026-11-06T06:00:00.000Z", { dailyLimit: 6 });
    const owners = prod.dataRows("Connections").map((c) => c[1]);
    expect(owners).toHaveLength(6);
    expect(new Set(owners)).toEqual(new Set(["anni", "lukky", "rishii"]));
    expect(owners.filter((m) => m === "anni")).toHaveLength(2); // round-robin: 2 each of the 6, not 6 each
  });

  it("interrupted progress resumes: a second call continues up to the same limit, never past it", async () => {
    const o = newOutreachSpreadsheet(masterGrid(manyContacts(12)));
    const sheet = new OutreachSheet(o.fake);
    await sheet.ensureTabs();
    expect((await imp(sheet, "2026-11-06T06:00:00.000Z", { perRun: 3 })).importedThisRun).toBe(3);
    expect((await imp(sheet, "2026-11-06T06:05:00.000Z", { perRun: 3 })).importedThisRun).toBe(2); // 5 in total, the limit
    expect((await imp(sheet, "2026-11-06T06:10:00.000Z", { perRun: 3 })).importedThisRun).toBe(0);
    expect(prod.dataRows("Connections")).toHaveLength(5);
  });

  it("concurrent imports cannot exceed the limit", async () => {
    const o = newOutreachSpreadsheet(masterGrid(manyContacts(30)));
    const sheet = new OutreachSheet(o.fake);
    await sheet.ensureTabs();
    const run = (ms: number) => imp(sheet, `2026-11-06T06:00:00.${String(ms).padStart(3, "0")}Z`, { staleClaimMs: 120_000 }); // as in production: another worker's fresh claim is not taken over
    await Promise.all([run(1), run(2), run(3)]); // distinct instants, as separate invocations always have
    // claims that lose a race may stay "importing" until their retry; only claims within the limit may ever become Connections
    const added = o.fake.dataRows("Added in Outreach Emails").filter((r) => r[0] && r[3] === "added" && r[23] !== "linked-existing");
    expect(added.length).toBeLessThanOrEqual(5);
    expect(prod.dataRows("Connections").length).toBeLessThanOrEqual(5);
    expect(new Set(prod.dataRows("Connections").map((c) => c[12])).size).toBe(prod.dataRows("Connections").length); // never a duplicate Connection
  });

  it("Master Contacts is never modified", async () => {
    const o = newOutreachSpreadsheet(masterGrid(manyContacts(8)));
    const before = JSON.stringify(o.fake.tabs.get("Master Contacts"));
    const sheet = new OutreachSheet(o.fake);
    await sheet.ensureTabs();
    await imp(sheet, "2026-11-06T06:00:00.000Z");
    expect(JSON.stringify(o.fake.tabs.get("Master Contacts"))).toBe(before);
  });
});

describe("Master Contacts read cache", () => {
  it("reads the static tab once per cache window when a cache key is given; never caches without one", async () => {
    clearMasterCache();
    const o = newOutreachSpreadsheet(masterGrid(manyContacts(3)));
    let reads = 0;
    const counting = new Proxy(o.fake, { get: (t, k) => (k === "getValues" ? (r: string) => { if (/Master Contacts/.test(r)) reads += 1; return t.getValues(r); } : (t as unknown as Record<string | symbol, unknown>)[k]) });
    const cached = new OutreachSheet(counting as unknown as typeof o.fake, "Master Contacts", "sheet-1");
    await cached.readMaster(); await cached.readMaster(); await cached.readMaster();
    expect(reads).toBe(1);
    const uncached = new OutreachSheet(counting as unknown as typeof o.fake);
    await uncached.readMaster(); await uncached.readMaster();
    expect(reads).toBe(3);
    clearMasterCache();
  });
});
