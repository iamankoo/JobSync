/**
 * Safeguards that make a controlled live test (and later activation) safe:
 * separate source tab, single-owner option, recipient allowlist, "manual since" cutoff.
 */
import { describe, expect, it } from "vitest";
import { loadOutreachConfig } from "@/lib/outreach/config";
import { matchesAllowlist } from "@/lib/outreach/exclusions";
import { runOutreachImport } from "@/lib/outreach/importer";
import { registerManualConnections } from "@/lib/outreach/manual";
import { realConnectionsPort } from "@/lib/outreach/run";
import { runSendStep } from "@/lib/outreach/send-workflow";
import { OutreachSheet } from "@/lib/outreach/sheet";
import { MASTER_TAB, TRACKING_TAB } from "@/lib/outreach/types";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { invalidateTableCache } from "@/lib/google-sheets/table";
import { createConnection } from "@/lib/google-sheets/connections-service";
import { createConnectionSchema } from "@/lib/validation/connections";
import { afterEach, beforeEach } from "vitest";
import { FakeSheets } from "../../helpers/fake-sheets";
import { manyContacts, masterGrid, masterRow, newOutreachSpreadsheet } from "../../helpers/outreach";
import { buildSendFixture } from "../../helpers/send-fixture";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("configuration of the safeguards", () => {
  it("source tab: defaults to Master Contacts; only a plain tab name is accepted", () => {
    expect(loadOutreachConfig(env({})).masterTab).toBe("Master Contacts");
    expect(loadOutreachConfig(env({ OUTREACH_MASTER_TAB: "Test Contacts" })).masterTab).toBe("Test Contacts");
    for (const bad of ["", "   ", "Tab!A1", "x'; DROP", "../x", "a".repeat(61)]) expect(loadOutreachConfig(env({ OUTREACH_MASTER_TAB: bad })).masterTab, bad).toBe("Master Contacts");
  });
  it("owner override: only a real member id; otherwise round-robin (null)", () => {
    expect(loadOutreachConfig(env({})).ownerOverride).toBeNull();
    expect(loadOutreachConfig(env({ OUTREACH_OWNER: "anni" })).ownerOverride).toBe("anni");
    expect(loadOutreachConfig(env({ OUTREACH_OWNER: "mallory" })).ownerOverride).toBeNull();
  });
  it("send allowlist: comma separated, lower-cased, malformed entries dropped (never widened)", () => {
    expect(loadOutreachConfig(env({})).sendAllowlist).toEqual([]);
    expect(loadOutreachConfig(env({ OUTREACH_SEND_ONLY_TO: " Me+JobSync*@Gmail.com , other@x.org,not-an-email, *" })).sendAllowlist).toEqual(["me+jobsync*@gmail.com", "other@x.org"]);
  });
  it("manual-since: an ISO instant, or empty when missing / invalid", () => {
    expect(loadOutreachConfig(env({})).manualSince).toBe("");
    expect(loadOutreachConfig(env({ OUTREACH_MANUAL_SINCE: "2026-11-05T10:00:00Z" })).manualSince).toBe("2026-11-05T10:00:00.000Z");
    expect(loadOutreachConfig(env({ OUTREACH_MANUAL_SINCE: "yesterday-ish" })).manualSince).toBe("");
  });
});

describe("matchesAllowlist", () => {
  const list = ["me+jobsync*@gmail.com", "exact@x.org"];
  it("matches the +alias pattern and exact addresses (case-insensitive), nothing else", () => {
    expect(matchesAllowlist("me+jobsync01@gmail.com", list)).toBe(true);
    expect(matchesAllowlist("ME+JobSync10@Gmail.com", list)).toBe(true);
    expect(matchesAllowlist("exact@x.org", list)).toBe(true);
    for (const no of ["me@gmail.com", "me+other@gmail.com", "me+jobsync01@gmail.org", "someone.else+jobsync01@gmail.com", "xme+jobsync01@gmail.com", "exact@x.org.evil.com", "hr@company.com", ""]) expect(matchesAllowlist(no, list), no).toBe(false);
  });
  it("an empty allowlist means no restriction", () => {
    expect(matchesAllowlist("anyone@anywhere.com", [])).toBe(true);
  });
});

describe("the send workflow honours the allowlist", () => {
  it("only allowlisted recipients can be sent to; everyone else is blocked before Gmail is read or called", async () => {
    const f = buildSendFixture([
      { email: "me+jobsync01@gmail.test", name: "Test One", company: "TestCo" },
      { email: "real.hr@company.example.com", name: "Real Hr", company: "Company" },
    ]);
    await f.seed();
    const r = await runSendStep(f.deps({ allowlist: ["me+jobsync*@gmail.test"] }));
    expect(r.sent).toBe(1);
    expect(f.gmail.sendCalls()).toEqual(["send:anni:draft_0_anni"]);
    expect(f.gmail.calls.some((c) => c.includes("draft_1"))).toBe(false); // the non-allowlisted draft was never even read
    const blocked = f.track().find((t) => t[1] === "real.hr@company.example.com")!;
    expect(blocked[21]).toBe("blocked");
    expect(blocked[25]).toMatch(/not on the send allowlist/);
  });
});

describe("importing from a separate tab, owned by one member, ignoring older manual Connections", () => {
  let prod: FakeSheets;
  beforeEach(() => {
    prod = new FakeSheets().seedMembers();
    setSheetsClientForTesting(prod);
    resetMembersCache();
    invalidateTableCache();
  });
  afterEach(() => setSheetsClientForTesting(null));

  const now = () => new Date("2026-11-06T06:00:00.000Z");

  it("reads ONLY the configured tab and never touches Master Contacts; with an owner override every Connection belongs to that member", async () => {
    const o = newOutreachSpreadsheet(masterGrid(manyContacts(3))); // the "real" Master Contacts
    const testRows = masterGrid([masterRow({ PersonEmail: "me+jobsync01@gmail.com", PersonName: "JobSync Test 01", CompanyName: "JobSync TEST Co 01" }), masterRow({ PersonEmail: "me+jobsync02@gmail.com", PersonName: "JobSync Test 02", CompanyName: "JobSync TEST Co 02" })]);
    o.fake.tabs.set("Test Contacts", testRows);
    const masterBefore = JSON.stringify(o.fake.tabs.get(MASTER_TAB));
    const sheet = new OutreachSheet(o.fake, "Test Contacts");
    await sheet.ensureTabs();
    const r = await runOutreachImport({ sheet, connections: realConnectionsPort, now, timezone: "Asia/Kolkata", dailyLimit: 200, perRun: 10, ownerOverride: "anni" });
    expect(r.importedThisRun).toBe(2);
    const conns = prod.dataRows("Connections");
    expect(conns.map((c) => c[12]).sort()).toEqual(["me+jobsync01@gmail.com", "me+jobsync02@gmail.com"]);
    expect(conns.every((c) => c[1] === "anni")).toBe(true);
    expect(o.fake.dataRows(TRACKING_TAB).filter((t) => t[0]).every((t) => t[5] === "anni")).toBe(true);
    expect(JSON.stringify(o.fake.tabs.get(MASTER_TAB))).toBe(masterBefore);
  });

  it("without an override, ownership is still round-robin", async () => {
    const o = newOutreachSpreadsheet(masterGrid(manyContacts(6)));
    const sheet = new OutreachSheet(o.fake);
    await sheet.ensureTabs();
    await runOutreachImport({ sheet, connections: realConnectionsPort, now, timezone: "Asia/Kolkata", dailyLimit: 200, perRun: 10 });
    expect(new Set(prod.dataRows("Connections").map((c) => c[1]))).toEqual(new Set(["anni", "lukky", "rishii"]));
  });

  it("manual Connections created before the cutoff are never picked up; later ones are", async () => {
    const o = newOutreachSpreadsheet(masterGrid([]));
    const sheet = new OutreachSheet(o.fake);
    await sheet.ensureTabs();
    await createConnection("lukky", createConnectionSchema.parse({ name: "Old Contact", company: "Old", email: "old@old.example.com", roleCategory: "SDE", applyRole: "Software Engineer", status: "Not Connected" }), new Date("2026-11-05T05:00:00.000Z"));
    await createConnection("lukky", createConnectionSchema.parse({ name: "New Contact", company: "New", email: "new@new.example.com", roleCategory: "SDE", applyRole: "Software Engineer", status: "Not Connected" }), new Date("2026-11-06T05:30:00.000Z"));
    const r = await registerManualConnections({ sheet, connections: realConnectionsPort, now, since: "2026-11-06T00:00:00.000Z" });
    expect(r.registered).toBe(1);
    expect(o.fake.dataRows(TRACKING_TAB).filter((t) => t[0]).map((t) => t[1])).toEqual(["new@new.example.com"]);
    // with no cutoff both would be picked up (within the 30-day window): the cutoff is what protects existing Connections
    const o2 = newOutreachSpreadsheet(masterGrid([]));
    const sheet2 = new OutreachSheet(o2.fake);
    await sheet2.ensureTabs();
    expect((await registerManualConnections({ sheet: sheet2, connections: realConnectionsPort, now })).registered).toBe(2);
  });
});
