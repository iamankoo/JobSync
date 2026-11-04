import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importEligibility, parseMasterRows, firstInDuplicateGroups } from "@/lib/outreach/contacts";
import { createConnection, deleteConnection, listConnections } from "@/lib/google-sheets/connections-service";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { invalidateTableCache } from "@/lib/google-sheets/table";
import { runOutreachImport } from "@/lib/outreach/importer";
import { realConnectionsPort } from "@/lib/outreach/run";
import { OutreachSheet } from "@/lib/outreach/sheet";
import { TRACKING_TAB } from "@/lib/outreach/types";
import { createConnectionSchema } from "@/lib/validation/connections";
import { FakeSheets } from "../../helpers/fake-sheets";
import { manyContacts, masterGrid, newOutreachSpreadsheet } from "../../helpers/outreach";
import { TEST_TAB, buildTestContactRows, cleanupTestArtifacts, testContactIds, testEmail } from "../../helpers/outreach-test-tool";

const LOCAL = "me";
const DOMAIN = "gmail.test";
let prod: FakeSheets;
let o: ReturnType<typeof newOutreachSpreadsheet>;
const now = () => new Date("2026-11-06T06:00:00.000Z");

beforeEach(async () => {
  prod = new FakeSheets().seedMembers();
  setSheetsClientForTesting(prod);
  resetMembersCache();
  invalidateTableCache();
  o = newOutreachSpreadsheet(masterGrid(manyContacts(5)));
  await o.sheet.ensureTabs();
});
afterEach(() => setSheetsClientForTesting(null));

describe("the 10 test contacts", () => {
  const rows = buildTestContactRows(LOCAL, DOMAIN);
  it("are clearly labelled, use the +jobsyncNN aliases, and are valid, eligible Outreach Database rows", () => {
    const parsed = parseMasterRows(masterGrid(rows));
    expect(parsed.rejected).toEqual([]);
    expect(parsed.contacts.map((c) => c.personEmail)).toEqual(Array.from({ length: 10 }, (_, i) => testEmail(LOCAL, DOMAIN, i + 1)));
    const first = firstInDuplicateGroups(parsed.contacts);
    expect(parsed.contacts.every((c) => importEligibility(c, first).eligible)).toBe(true);
    for (const c of parsed.contacts) expect(`${c.personName} ${c.companyName} ${c.personDesignation} ${c.companyDescription}`.trim()).toMatch(/JobSync Test|JobSync TEST|TEST ENTRY/);
    expect(parsed.contacts[8].personName).toBe(""); // Hiring Team case
    expect(parsed.contacts[9].companyName).toBe(""); // your company case
    expect(new Set(parsed.contacts.map((c) => c.primaryRoleCategory)).size).toBeGreaterThan(4); // several resume kinds
  });
});

describe("cleanup removes ONLY test artefacts", () => {
  it("deletes the test Connections, drafts, tracking, ledger, milestone and counter rows, and leaves real data untouched", async () => {
    // a REAL Connection and a real tracking row that must survive
    const real = await createConnection("lukky", createConnectionSchema.parse({ name: "Real Person", company: "Real Co", email: "real@realco.example.com", roleCategory: "SDE", applyRole: "Software Engineer", status: "Not Connected" }));
    // import the 10 test contacts through the real importer, from the isolated tab
    o.fake.tabs.set(TEST_TAB, masterGrid(buildTestContactRows(LOCAL, DOMAIN)));
    const testSheet = new OutreachSheet(o.fake, TEST_TAB);
    const r = await runOutreachImport({ sheet: testSheet, connections: realConnectionsPort, now, timezone: "Asia/Kolkata", dailyLimit: 200, perRun: 10, ownerOverride: "anni" });
    expect(r.importedThisRun).toBe(10);
    const testConns = prod.dataRows("Connections").filter((c) => c[12].startsWith(`${LOCAL}+jobsync`));
    expect(testConns).toHaveLength(10);
    // drafts for the test Connections (all members) and for the real one
    const draftRow = (cid: string, m: string, id: string) => [`contact:${cid}:${m}`, m, "contact", cid, id, "created", "", "", "", ""];
    for (const c of testConns) for (const m of ["anni", "lukky", "rishii"]) prod.rows("NF_Drafts").push(draftRow(c[0], m, `gd-${c[0]}-${m}`));
    prod.rows("NF_Drafts").push(draftRow(real.connectionId, "lukky", "gd-real"));
    // bookkeeping the test produced, plus REAL bookkeeping that must stay
    await o.sheet.appendSendRecord({ row: 0, sendKey: testEmail(LOCAL, DOMAIN, 1), contactId: "x", claimId: "c1", status: "sent", member: "anni", gmailAccount: "", connectionId: testConns[0][0], company: "", role: "", resumeFile: "", resumeSha256: "", resumeBytes: 0, draftId: "", threadId: "", gmailMessageId: "m", wordCount: 1, attempts: 1, notBefore: "", sentAt: "", sentDay: "", reason: "", history: "", createdAt: "", updatedAt: "" }, 2);
    await o.sheet.setState("connections-announced", "10", now().toISOString());
    await o.sheet.claimMilestone("connections:10", "id1", now().toISOString());
    invalidateTableCache();

    const deleted: string[] = [];
    const report = await cleanupTestArtifacts({
      local: LOCAL, domain: DOMAIN, outreach: o.fake, prod,
      listConnections,
      deleteConnection: async (owner, id) => { await deleteConnection(owner, id); },
      deleteGmailDraft: async (m, id) => { deleted.push(`${m}:${id}`); return "deleted"; },
    });
    expect(report).toMatchObject({ connectionsDeleted: 10, gmailDraftsDeleted: 30, gmailDraftErrors: 0, draftLedgerRowsDeleted: 30, trackingRowsDeleted: 10, sendLedgerRowsDeleted: 1, realTrackingRowsRemaining: 0 });
    expect(report.stateRowsDeleted).toBe(2);
    expect(deleted).toHaveLength(30);
    expect(deleted.some((d) => d.includes("gd-real"))).toBe(false);
    // real data intact
    expect(prod.dataRows("Connections").map((c) => c[0])).toEqual([real.connectionId]);
    expect(prod.dataRows("NF_Drafts").map((d) => d[4])).toEqual(["gd-real"]);
    expect(o.fake.dataRows(TRACKING_TAB).filter((t) => t[0])).toHaveLength(0);
    // the Master Contacts source rows were never touched
    expect(o.fake.tabs.get("Master Contacts")!.length).toBe(6);
    expect(testContactIds(LOCAL, DOMAIN).size).toBe(10);
  });

  it("keeps shared milestone state and counters when REAL tracking rows exist, and deletes nothing when a Gmail draft cannot be deleted", async () => {
    o.fake.tabs.set(TEST_TAB, masterGrid(buildTestContactRows(LOCAL, DOMAIN)));
    await runOutreachImport({ sheet: new OutreachSheet(o.fake, TEST_TAB), connections: realConnectionsPort, now, timezone: "Asia/Kolkata", dailyLimit: 200, perRun: 10, ownerOverride: "anni" });
    await runOutreachImport({ sheet: o.sheet, connections: realConnectionsPort, now, timezone: "Asia/Kolkata", dailyLimit: 200, perRun: 2 }); // 2 real imports from Master Contacts
    await o.sheet.claimMilestone("connections:10", "id1", now().toISOString());
    const testConns = prod.dataRows("Connections").filter((c) => c[12].startsWith(`${LOCAL}+jobsync`));
    prod.rows("NF_Drafts").push([`contact:${testConns[0][0]}:anni`, "anni", "contact", testConns[0][0], "gd-1", "created", "", "", "", ""]);
    invalidateTableCache();
    const failing = await cleanupTestArtifacts({ local: LOCAL, domain: DOMAIN, outreach: o.fake, prod, listConnections, deleteConnection: async (a, b) => { await deleteConnection(a, b); }, deleteGmailDraft: async () => "error" });
    expect(failing).toMatchObject({ gmailDraftErrors: 1, connectionsDeleted: 0, draftLedgerRowsDeleted: 0, trackingRowsDeleted: 0 });
    expect(o.fake.dataRows(TRACKING_TAB).filter((t) => t[0])).toHaveLength(12); // tracking untouched: the cleanup can be re-run
    expect(prod.dataRows("Connections")).toHaveLength(12); // nothing deleted while a draft could not be removed
    const ok = await cleanupTestArtifacts({ local: LOCAL, domain: DOMAIN, outreach: o.fake, prod, listConnections, deleteConnection: async (a, b) => { await deleteConnection(a, b); }, deleteGmailDraft: vi.fn(async () => "deleted" as const) });
    expect(ok).toMatchObject({ connectionsDeleted: 10, trackingRowsDeleted: 10, realTrackingRowsRemaining: 2, stateRowsDeleted: 0, counterRowsDeleted: 0 });
    expect(prod.dataRows("Connections")).toHaveLength(2); // the 2 real imports stay
    expect(o.fake.dataRows(TRACKING_TAB).filter((t) => t[0])).toHaveLength(2);
    expect([...(await o.sheet.claimedMilestones(now().toISOString()))]).toContain("connections:10"); // shared state kept: real work exists
  });

  it("handles member|recipient send keys, keeps real ledger rows, never deletes SENT drafts' messages, is a no-op on dry run and idempotent", async () => {
    o.fake.tabs.set(TEST_TAB, masterGrid(buildTestContactRows(LOCAL, DOMAIN)));
    await runOutreachImport({ sheet: new OutreachSheet(o.fake, TEST_TAB), connections: realConnectionsPort, now, timezone: "Asia/Kolkata", dailyLimit: 200, perRun: 10, ownerOverride: "anni" });
    const conns = prod.dataRows("Connections").filter((c) => c[12].startsWith(`${LOCAL}+jobsync`));
    const draft = (cid: string, m: string, status: string) => [`contact:${cid}:${m}`, m, "contact", cid, `gd-${cid}-${m}`, status, "", "", "", ""];
    for (const c of conns) { prod.rows("NF_Drafts").push(draft(c[0], "anni", "sent")); prod.rows("NF_Drafts").push(draft(c[0], "lukky", "created")); }
    const ledger = (key: string, member: string) => ({ row: 0, sendKey: key, contactId: "x", claimId: `c-${key}`, status: "sent" as const, member, gmailAccount: "", connectionId: "", company: "", role: "", resumeFile: "", resumeSha256: "", resumeBytes: 0, draftId: "", threadId: "", gmailMessageId: "m", wordCount: 1, attempts: 1, notBefore: "", sentAt: "", sentDay: "", reason: "", history: "", createdAt: "", updatedAt: "" });
    await o.sheet.appendSendRecord(ledger(`anni|${testEmail(LOCAL, DOMAIN, 1)}`, "anni"), 2);
    await o.sheet.appendSendRecord(ledger("anni|real@realco.example.com", "anni"), 3);
    invalidateTableCache();
    const deleted: string[] = [];
    const ports = { local: LOCAL, domain: DOMAIN, outreach: o.fake, prod, listConnections, deleteConnection: async (a: Parameters<typeof deleteConnection>[0], b: string) => { await deleteConnection(a, b); }, deleteGmailDraft: async (m: string, id: string) => { deleted.push(`${m}:${id}`); return "deleted" as const; } };
    const dry = await cleanupTestArtifacts({ ...ports, dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, connectionsDeleted: 10, gmailDraftsDeleted: 10, sentDraftsKept: 10, sendLedgerRowsDeleted: 1 });
    expect(deleted).toEqual([]);
    expect(prod.dataRows("Connections")).toHaveLength(10);
    const real = await cleanupTestArtifacts(ports);
    expect(real).toMatchObject({ dryRun: false, connectionsDeleted: 10, gmailDraftsDeleted: 10, draftLedgerRowsDeleted: 20, sendLedgerRowsDeleted: 1 });
    expect(deleted.every((d) => d.startsWith("lukky:"))).toBe(true); // only UNSENT drafts are deleted from Gmail
    expect(o.fake.dataRows("Outreach Send Ledger").filter((r) => r[0]).map((r) => r[0])).toEqual(["anni|real@realco.example.com"]);
    const again = await cleanupTestArtifacts(ports);
    expect(again).toMatchObject({ connectionsDeleted: 0, gmailDraftsDeleted: 0, draftLedgerRowsDeleted: 0, trackingRowsDeleted: 0, sendLedgerRowsDeleted: 0 });
  });
});
