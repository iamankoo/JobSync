/**
 * Priority import: contacts of the optional "Priority Contacts" tab are imported BEFORE the rest of Master Contacts, without renumbering or
 * rewriting anything, under the same 200-per-rolling-24-hours import limit and the same de-duplication, eligibility and send safeguards.
 * Synthetic data and in-memory fakes only: nothing real is read, written or sent.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MEMBER_IDS } from "@/config/members";
import { contactIdFor } from "@/lib/hr-master/ids";
import { emailKindOf, emailDomain } from "@/lib/hr-master/normalize";
import { MASTER_FIELDS } from "@/lib/hr-master/types";
import { dateOf, mapRole, orderPlan, planPriorityContacts, priorityTabRows, type NewDataRow, type PlanContext } from "@/lib/hr-master/priority-plan";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { createConnection } from "@/lib/google-sheets/connections-service";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { invalidateTableCache } from "@/lib/google-sheets/table";
import { eligibleIdSet, importEligibility, importOrder, parseMasterRows } from "@/lib/outreach/contacts";
import { runOutreachImport, connectionInputFor, type ImportDeps } from "@/lib/outreach/importer";
import { resolvePriorityContacts } from "@/lib/outreach/priority";
import { realConnectionsPort, runOutreachCycle } from "@/lib/outreach/run";
import { runSendStep } from "@/lib/outreach/send-workflow";
import { PRIORITY_TAB, TRACKING_TAB } from "@/lib/outreach/types";
import { createConnectionSchema } from "@/lib/validation/connections";
import { FakeSheets } from "../helpers/fake-sheets";
import { manyContacts, masterGrid, masterRow, newOutreachSpreadsheet } from "../helpers/outreach";
import { buildSendFixture } from "../helpers/send-fixture";

const priorityGrid = (rows: string[][]) => [[...MASTER_FIELDS], ...rows];
const idOnly = (id: string) => MASTER_FIELDS.map((f) => (f === "ContactID" ? id : ""));
const fresh = (email: string, name = "", company = "Fresh Co") => masterRow({ PersonEmail: email, PersonName: name, CompanyName: company, PrimaryRoleCategory: "AI/ML Engineer" });
const idOfEmail = (e: string) => contactIdFor(e);

let prod: FakeSheets;
let outreach: ReturnType<typeof newOutreachSpreadsheet>;
const clock = new Date("2026-11-10T06:00:00.000Z");
const deps = (over: Partial<ImportDeps> = {}): ImportDeps => ({ sheet: outreach.sheet, connections: realConnectionsPort, now: () => clock, timezone: "Asia/Kolkata", dailyLimit: 200, perRun: 50, ...over });

async function setup(masterRows: string[][], priorityRows?: string[][]) {
  prod = new FakeSheets().seedMembers();
  setSheetsClientForTesting(prod);
  resetMembersCache();
  invalidateTableCache();
  outreach = newOutreachSpreadsheet(masterGrid(masterRows));
  if (priorityRows) outreach.fake.tabs.set(PRIORITY_TAB, priorityGrid(priorityRows));
  await outreach.sheet.ensureTabs();
}
afterEach(() => setSheetsClientForTesting(null));
const imported = () => outreach.fake.dataRows(TRACKING_TAB).filter((r) => r[0]).map((r) => r[0]); // ContactIDs in import order
const masterOrder = (rows: string[][]) => parseMasterRows(masterGrid(rows)).contacts.filter((c) => importEligibility(c, new Set()).eligible).sort(importOrder).map((c) => c.contactId);

// ---------------------------------------------------------------------------------------------------------------------------------
describe("the priority list is optional: without the tab nothing changes", () => {
  it("a spreadsheet without a Priority Contacts tab has no priority list (the tab is never created by the reader)", async () => {
    await setup(manyContacts(5));
    expect(await outreach.sheet.readPriority()).toEqual([]);
    expect(outreach.fake.tabs.has(PRIORITY_TAB)).toBe(false);
  });

  it("the import order is exactly the usual one when there is no priority list", async () => {
    const master = manyContacts(12);
    await setup(master);
    await runOutreachImport(deps({ perRun: 12 }));
    expect(imported()).toEqual(masterOrder(master));
  });

  it("another read failure (for example Google's quota) is NOT mistaken for 'no priority list'", async () => {
    await setup(manyContacts(3));
    const real = outreach.fake.getValues.bind(outreach.fake);
    const { SheetsError } = await import("@/lib/google-sheets/errors");
    outreach.fake.getValues = async (range: string) => { if (range.includes(PRIORITY_TAB)) throw new SheetsError("rate_limited", "busy"); return real(range); };
    await expect(outreach.sheet.readPriority()).rejects.toThrow(/busy/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("resolving the priority list", () => {
  const master = () => parseMasterRows(masterGrid(manyContacts(10)));

  it("full rows are parsed with Master's own rules; ID-only rows promote the existing Master contact (its data and ContactID are kept)", () => {
    const m = master();
    const target = m.contacts[7];
    const r = resolvePriorityContacts(priorityGrid([fresh("new1@fresh1.example.com", "Ann Founder"), idOnly(target.contactId), fresh("new2@fresh2.example.com")]), m);
    expect(r.contacts.map((c) => c.personEmail)).toEqual(["new1@fresh1.example.com", target.personEmail, "new2@fresh2.example.com"]); // the tab's own order
    expect(r.contacts[1]).toBe(target); // the very same Master contact: nothing re-created or re-numbered
    expect([...r.promotedIds]).toEqual([target.contactId]);
    expect(r.rejected).toEqual([]);
    expect(r.contacts[0].sheetRow).toBe(2);
  });

  it("unusable rows are reported, never imported: bad e-mail, wrong ContactID, unknown promoted id, duplicates inside the list", () => {
    const m = master();
    const bad = fresh("ok@fresh.example.com");
    const wrongId = [...fresh("other@fresh.example.com")];
    wrongId[MASTER_FIELDS.indexOf("ContactID")] = "HRC-000000000000";
    const noEmail = [...fresh("x@x.example.com")];
    noEmail[MASTER_FIELDS.indexOf("PersonEmail")] = "not-an-address";
    const r = resolvePriorityContacts(priorityGrid([bad, wrongId, noEmail, idOnly("HRC-UNKNOWN00000"), bad, idOnly(m.contacts[1].contactId), idOnly(m.contacts[1].contactId)]), m);
    expect(r.contacts.map((c) => c.personEmail)).toEqual(["ok@fresh.example.com", m.contacts[1].personEmail]);
    expect(r.rejected.map((x) => x.reason)).toEqual([
      "ContactID does not match the e-mail address",
      "invalid e-mail (must contain exactly one @)",
      "promoted ContactID is not in Master Contacts",
      "duplicate in the Priority Contacts list",
      "duplicate in the Priority Contacts list",
    ]);
  });

  it("an empty or header-only tab is an empty list; a tab without ContactID / PersonEmail is rejected as a whole", () => {
    const m = master();
    expect(resolvePriorityContacts([], m).contacts).toEqual([]);
    expect(resolvePriorityContacts([[...MASTER_FIELDS]], m).contacts).toEqual([]);
    const broken = resolvePriorityContacts([["Name", "Mail"], ["a", "b"]], m);
    expect(broken.contacts).toEqual([]);
    expect(broken.rejected[0].reason).toMatch(/lacks ContactID/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("the importer takes the priority queue first, then the rest of Master Contacts", () => {
  it("priority contacts (in tab order, promoted ones included) come before every older Master contact; the rest follows in the usual order", async () => {
    const master = manyContacts(30);
    const m = parseMasterRows(masterGrid(master));
    const usual = masterOrder(master);
    const late = [usual[25], usual[28]]; // two contacts that would have been imported very late
    const newOnes = ["a@fresh1.example.com", "b@fresh2.example.com", "c@fresh3.example.com"];
    await setup(master, [fresh(newOnes[0], "Ann Founder"), idOnly(late[0]), fresh(newOnes[1]), idOnly(late[1]), fresh(newOnes[2])]);
    await runOutreachImport(deps({ perRun: 50 }));
    const order = imported();
    expect(order.slice(0, 5)).toEqual([idOfEmail(newOnes[0]), late[0], idOfEmail(newOnes[1]), late[1], idOfEmail(newOnes[2])]);
    expect(order.slice(5)).toEqual(usual.filter((id) => !late.includes(id))); // the remaining backlog keeps its own order
    expect(order).toHaveLength(33); // 30 Master + 3 new (the two promoted contacts ARE Master contacts, so they add nothing)
    expect(new Set(order).size).toBe(order.length);
    expect(m.contacts.some((c) => c.contactId === late[0])).toBe(true);
  });

  it("nothing is rewritten: Master Contacts and the Priority tab are byte-for-byte unchanged, ContactIDs are the e-mail-derived ones, notes carry them", async () => {
    const master = manyContacts(8);
    await setup(master, [fresh("keep@fresh.example.com", "Ann Founder")]);
    const masterBefore = JSON.stringify(outreach.fake.tabs.get("Master Contacts"));
    const priorityBefore = JSON.stringify(outreach.fake.tabs.get(PRIORITY_TAB));
    await runOutreachImport(deps());
    expect(JSON.stringify(outreach.fake.tabs.get("Master Contacts"))).toBe(masterBefore);
    expect(JSON.stringify(outreach.fake.tabs.get(PRIORITY_TAB))).toBe(priorityBefore);
    const conn = prod.dataRows("Connections").find((r) => r[8]?.includes(idOfEmail("keep@fresh.example.com")));
    expect(conn).toBeTruthy();
    expect(conn![8]).toMatch(/^Source: Outreach Database HRC-/);
    const row = outreach.fake.dataRows(TRACKING_TAB).find((r) => r[0] === idOfEmail("keep@fresh.example.com"))!;
    expect(row[2]).toBe("outreach-database"); // a priority contact is a database import like any other
    expect(row[3]).toBe("added");
  });

  it("the 200 limit still applies to priority contacts: the limit is shared, nothing is skipped, and the next window continues with the remaining PRIORITY contacts before Master", async () => {
    const master = manyContacts(20);
    const prio = Array.from({ length: 7 }, (_, i) => fresh(`p${i}@prio${i}.example.com`));
    await setup(master, prio);
    const first = await runOutreachImport(deps({ dailyLimit: 5 }));
    expect(first).toMatchObject({ importedThisRun: 5, stoppedBecause: "daily-limit", priorityRemaining: 2 });
    expect(imported()).toEqual(prio.slice(0, 5).map((r) => r[0]));
    const later = new Date(clock.getTime() + 25 * 3600_000);
    const second = await runOutreachImport(deps({ dailyLimit: 5, now: () => later }));
    expect(second.priorityRemaining).toBe(0);
    expect(imported().slice(5, 7)).toEqual(prio.slice(5).map((r) => r[0])); // the last two priority contacts first...
    expect(imported().slice(7)).toHaveLength(3); // ...then Master continues
  });

  it("de-duplication is unchanged: a contact already tracked, already a Connection, or listed twice (priority and Master) is imported at most once", async () => {
    const master = manyContacts(6);
    const m = parseMasterRows(masterGrid(master));
    const inConnections = "conn@fresh.example.com";
    await setup(master, [fresh("one@fresh.example.com"), idOnly(m.contacts[2].contactId), fresh(inConnections), fresh(m.contacts[3].personEmail, "", "Twin Co")]);
    // the same person as a Master row, listed in the priority tab as a "full" row with the Master's own e-mail -> still one tracking row
    await createConnection("anni", createConnectionSchema.parse({ name: "Manual Person", company: "Manual Co", role: "Recruiter", email: inConnections, status: "Not Connected" }), new Date(), { notify: false });
    await runOutreachImport(deps({ perRun: 50 }));
    const ids = imported();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(idOfEmail(inConnections)); // already a Connection: never created again
    expect(ids.filter((id) => id === m.contacts[3].contactId)).toHaveLength(1);
    await runOutreachImport(deps({ perRun: 50 })); // running again changes nothing
    expect(imported()).toEqual(ids);
  });

  it("a contact the importer would not accept (no mappable role) is not imported just because it is in the priority tab", async () => {
    const noRole = masterRow({ PersonEmail: "norole@fresh.example.com", CompanyName: "NoRole", PrimaryRoleCategory: "Unverified" });
    await setup(manyContacts(3), [noRole, fresh("good@fresh.example.com")]);
    await runOutreachImport(deps());
    expect(imported()).not.toContain(idOfEmail("norole@fresh.example.com"));
    expect(imported()).toContain(idOfEmail("good@fresh.example.com"));
  });

  it("an interrupted priority import is finished on the next call (recovery sees priority contacts)", async () => {
    await setup(manyContacts(4), [fresh("rec@fresh.example.com")]);
    await runOutreachImport(deps({ perRun: 1 }));
    const rows = outreach.fake.tabs.get(TRACKING_TAB)!;
    rows[1][3] = "importing"; // crash after the claim, before the Connection was confirmed
    prod.tabs.set("Connections", prod.tabs.get("Connections")!.filter((r, i) => i === 0 || !String(r[8] ?? "").includes(idOfEmail("rec@fresh.example.com"))));
    invalidateTableCache();
    await runOutreachImport(deps({ perRun: 1, staleClaimMs: 0 }));
    expect(outreach.fake.dataRows(TRACKING_TAB).find((r) => r[0] === idOfEmail("rec@fresh.example.com"))![3]).toBe("added");
    expect(prod.dataRows("Connections").filter((r) => String(r[8] ?? "").includes(idOfEmail("rec@fresh.example.com")))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("priority contacts are sent like any other, under every existing safeguard", () => {
  it("a priority contact that is NOT in Master Contacts is eligible to send (without the priority tab it would be blocked as unknown)", async () => {
    const f = buildSendFixture([{ email: "prio@fresh.example.com", name: "Pat Prio", company: "PrioCo", members: [...MEMBER_IDS] }]);
    f.fake.tabs.set("Master Contacts", masterGrid(manyContacts(3))); // Master does not contain the contact
    await f.seed();
    const blocked = await runSendStep(f.deps());
    expect(blocked.sent).toBe(0);
    expect(f.track()[0][25]).toMatch(/\[eligible\].*not eligible/);
    f.fake.tabs.set(PRIORITY_TAB, priorityGrid([masterRow({ PersonEmail: "prio@fresh.example.com", PersonName: "Pat Prio", CompanyName: "PrioCo", PrimaryRoleCategory: "Software Engineer" })]));
    const sent = await runSendStep(f.deps());
    expect(sent.sent).toBe(3); // one e-mail from each member, from their own Gmail
    expect(f.gmail.sentMessages.map((m) => m.member).sort()).toEqual([...MEMBER_IDS].sort());
  });

  it("opt-outs and every other safeguard still apply to priority contacts", async () => {
    const f = buildSendFixture([{ email: "optout@fresh.example.com", name: "Opt Out", company: "OptCo", members: [...MEMBER_IDS] }]);
    f.fake.tabs.set("Master Contacts", masterGrid(manyContacts(2)));
    f.fake.tabs.set(PRIORITY_TAB, priorityGrid([masterRow({ PersonEmail: "optout@fresh.example.com", PersonName: "Opt Out", CompanyName: "OptCo", PrimaryRoleCategory: "Software Engineer" })]));
    f.fake.tabs.set("Outreach Exclusions", [["Value", "Reason", "AddedAt", "AddedBy"], ["optout@fresh.example.com", "asked not to be contacted", "", "anni"]]);
    await f.seed();
    expect((await runSendStep(f.deps())).sent).toBe(0);
    expect(f.track()[0][25]).toMatch(/\[not_excluded\]/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("the 'contacts still waiting' counter includes priority contacts that are not in Master", () => {
  it("queueRemaining = eligible untracked Master contacts + untracked priority-only contacts (promoted ones are not counted twice)", async () => {
    const master = manyContacts(10);
    const m = parseMasterRows(masterGrid(master));
    await setup(master, [fresh("only1@fresh1.example.com"), fresh("only2@fresh2.example.com"), idOnly(m.contacts[4].contactId)]);
    const result = await runOutreachCycle({
      config: { enabled: true, spreadsheetId: "x", dailyLimit: 200, perRun: 1, draftsPerRun: 2, masterTab: "Master Contacts", ownerOverride: null, sendAllowlist: [], manualSince: "", sendFirstAt: 0 },
      sheet: outreach.sheet, connections: realConnectionsPort, ledger: async () => new Map(), connected: async () => [], gate: false, now: () => clock, timezone: "Asia/Kolkata",
    });
    expect(result.errors).toEqual([]);
    expect(result.import).toMatchObject({ importedThisRun: 1, priorityRemaining: 2 });
    // 10 Master + 2 priority-only = 12 eligible; 1 imported (a priority contact) -> 11 left
    expect(result.counters?.queueRemaining).toBe(11);
    expect(eligibleIdSet(m).size).toBe(10);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("the plan for a new contact list (src/lib/hr-master/priority-plan.ts)", () => {
  const row = (n: number, over: Partial<NewDataRow> = {}): NewDataRow => ({
    sourceRow: n, company: `Co${n}`, email: `hello@co${n}.example.com`, openRoles: `YC S22 · 2 listed roles\nSoftware Engineer; Product Designer`, founderProfile: `Pat Founder${n} · Founder`,
    hiringChecked: "46302.0", provenance: "Public YC launch contact; hiring ownership unconfirmed", ...over,
  });
  const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({ trackedEmails: new Set(), trackedIds: new Set(), connectionEmails: new Set(), masterIdByEmail: new Map(), exclusions: [], ...over });

  it("classifies every row once: new, promoted, or skipped with the reason", () => {
    const rows = [
      row(1), row(2, { email: "not-an-email" }), row(3, { email: "hello@co1.example.com" }), row(4, { email: "gone@vsnl.net" }), row(5, { email: "done@imported.example.com" }),
      row(6, { email: "known@connections.example.com" }), row(7, { email: "stop@optout.example.com" }), row(8, { email: "inmaster@master.example.com" }), row(9, { openRoles: "YC W23 · 1 listed roles\nAccount Executive" }),
      row(10, { email: "inmaster2@master.example.com", openRoles: "YC W23 · 1 listed roles\nLegal Counsel" }),
    ];
    const plan = planPriorityContacts(rows, ctx({
      trackedEmails: new Set(["done@imported.example.com"]), connectionEmails: new Set(["known@connections.example.com"]), exclusions: [{ value: "optout.example.com", reason: "asked" }],
      masterIdByEmail: new Map([["inmaster@master.example.com", "HRC-MASTER000001"], ["inmaster2@master.example.com", "HRC-MASTER000002"]]),
    }));
    expect(plan.map((p) => p.status)).toEqual(["new", "invalid", "duplicate-in-file", "legacy-isp", "already-imported", "already-connection", "opted-out", "promote", "no-mappable-role", "promote"]);
    expect(plan[7].contactId).toBe("HRC-MASTER000001"); // promoted: the existing ContactID, never a new one
    expect(plan[9].status).toBe("promote"); // a Master contact is judged on its OWN Master data, not on this file's role text
    expect(plan[0].contactId).toBe(contactIdFor("hello@co1.example.com"));
  });

  it("location, citizenship, visa and sponsorship wording never excludes anybody", () => {
    const rows = [
      row(1, { openRoles: "YC W22 · 1 listed roles\nSoftware Engineer\nUS citizen/visa only" }),
      row(2, { provenance: "US citizenship required; will not sponsor" }),
      row(3, { openRoles: "YC S23 · 1 listed roles\nBackend Engineer\nUS citizenship/visa not required\nWill sponsor" }),
    ];
    expect(planPriorityContacts(rows, ctx()).map((p) => p.status)).toEqual(["new", "new", "new"]);
    expect(Object.keys(row(1))).not.toContain("restrictions"); // the plan does not even look at location / visa fields
  });

  it("orders best-identified first (a named founder before a company mailbox), then the file's order, and numbers from the given position", () => {
    const rows = [row(1), row(2, { email: "pat.founder2@co2.example.com" }), row(3), row(4, { email: "pat.founder4@co4.example.com" })];
    const ordered = orderPlan(planPriorityContacts(rows, ctx()), 1211);
    expect(ordered.map((o) => o.sourceRow)).toEqual([2, 4, 1, 3]);
    expect(ordered.map((o) => o.position)).toEqual([1211, 1212, 1213, 1214]);
    expect(ordered.map((o) => o.segment)).toEqual(["person-and-company", "person-and-company", "company-only", "company-only"]);
    expect(ordered[0].founderName).toBe("Pat Founder2");
    expect(ordered[2].founderName).toBe(""); // a company mailbox is not addressed to the founder by name
  });

  it("the rendered tab uses the Master Contacts columns; a promoted contact is an ID-only row; every row is accepted by the real parser and importer", () => {
    const rows = [row(1), row(2, { email: "pat.founder2@co2.example.com" }), row(3, { email: "inmaster@master.example.com" })];
    const master = parseMasterRows(masterGrid([masterRow({ PersonEmail: "inmaster@master.example.com", CompanyName: "MasterCo" })]));
    const plan = orderPlan(planPriorityContacts(rows, ctx({ masterIdByEmail: new Map([["inmaster@master.example.com", master.contacts[0].contactId]]) })), 1);
    const tab = priorityTabRows(plan);
    expect(tab[0]).toEqual([...MASTER_FIELDS]);
    const promoted = tab.find((r) => r[MASTER_FIELDS.indexOf("ContactID")] === master.contacts[0].contactId)!;
    expect(promoted.filter(Boolean)).toEqual([master.contacts[0].contactId]);
    const resolved = resolvePriorityContacts(tab, master);
    expect(resolved.rejected).toEqual([]);
    expect(resolved.contacts).toHaveLength(3);
    for (const c of resolved.contacts) {
      expect(importEligibility(c, new Set()).eligible).toBe(true);
      expect(createConnectionSchema.safeParse(connectionInputFor(c)).success).toBe(true);
    }
    const fresh1 = resolved.contacts.find((c) => c.personEmail === "pat.founder2@co2.example.com")!;
    expect(fresh1.personName).toBe("Pat Founder2");
    expect(fresh1.contactId).toBe(contactIdFor("pat.founder2@co2.example.com"));
    expect(emailKindOf(emailDomain(fresh1.personEmail))).toBe("company");
  });

  it("role mapping and date helpers", () => {
    expect(mapRole("Founding AI Agent Engineer")).toBe("AI/ML Engineer");
    expect(mapRole("Machine Learning Engineer")).toBe("AI/ML Engineer");
    expect(mapRole("Full Stack Engineer; Growth")).toBe("Full Stack Engineer");
    expect(mapRole("Senior Backend Developer")).toBe("Backend Engineer");
    expect(mapRole("Data Engineer")).toBe("Data Engineer");
    expect(mapRole("Software Engineer Internship")).toBe("Software Engineer");
    expect(mapRole("Account Executive; Chief of Staff; Head of Legal")).toBeNull();
    expect(dateOf("46302.0")).toBe("2026-10-07");
    expect(dateOf("2026-11-10T00:00:00Z")).toBe("2026-11-10");
    expect(dateOf("")).toBe("");
  });
});

describe("the review/apply script is safe by construction", () => {
  const script = fs.readFileSync(path.resolve(__dirname, "../../scripts/outreach/priority-contacts.mts"), "utf8");
  it("is a dry run unless BOTH --apply and --i-have-owner-approval are given, refuses the production spreadsheet, and never touches Master Contacts", () => {
    expect(script).toMatch(/if \(apply && !flag\("--i-have-owner-approval"\)\) throw/);
    expect(script).toMatch(/id === prodId\) throw new Error\("Refusing: that is the production spreadsheet/);
    expect(script).toContain("spreadsheets.readonly");
    expect(script).toMatch(/Refusing: "\$\{TAB\}" already holds/);
    const writes = script.split("\n").filter((l) => /values\.update|batchUpdate|values\.append|values\.clear/.test(l));
    expect(writes.every((l) => !/Master Contacts/.test(l))).toBe(true);
    expect(script).toContain("DRY RUN: nothing was written to Google Sheets.");
  });
});
