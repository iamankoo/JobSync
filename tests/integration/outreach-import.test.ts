/**
 * Part 2: the daily Outreach Database import, resume after interruption, duplicate prevention across automatic and manual
 * additions, the four contact-quality segments and permissions. Everything runs against in-memory fakes: the production
 * spreadsheet is a FakeSheets, the Outreach Database is another FakeSheets, and no Gmail or network is involved.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnection, updateConnection } from "@/lib/google-sheets/connections-service";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { invalidateTableCache } from "@/lib/google-sheets/table";
import { createConnectionSchema } from "@/lib/validation/connections";
import { runOutreachImport, type ImportDeps } from "@/lib/outreach/importer";
import { registerManualConnections } from "@/lib/outreach/manual";
import { realConnectionsPort } from "@/lib/outreach/run";
import { MAX_IMPORT_ATTEMPTS, TRACKING_TAB } from "@/lib/outreach/types";
import { FakeSheets } from "../helpers/fake-sheets";
import { manyContacts, masterGrid, masterRow, newOutreachSpreadsheet } from "../helpers/outreach";
import type { MemberId } from "@/config/members";

let prod: FakeSheets;
let outreach: ReturnType<typeof newOutreachSpreadsheet>;
let clock = new Date("2026-11-05T05:00:00.000Z"); // 10:30 IST
const now = () => clock;

function deps(over: Partial<ImportDeps> = {}): ImportDeps {
  return { sheet: outreach.sheet, connections: realConnectionsPort, now, timezone: "Asia/Kolkata", dailyLimit: 200, perRun: 50, ...over };
}
async function setup(master: string[][]) {
  prod = new FakeSheets().seedMembers();
  setSheetsClientForTesting(prod);
  resetMembersCache();
  invalidateTableCache();
  outreach = newOutreachSpreadsheet(masterGrid(master));
  await outreach.sheet.ensureTabs();
}
const connections = () => prod.dataRows("Connections");
const tracking = () => outreach.fake.dataRows(TRACKING_TAB).filter((r) => r[0]);
const masterBefore = () => JSON.stringify(outreach.fake.tabs.get("Master Contacts"));

beforeEach(() => {
  clock = new Date("2026-11-05T05:00:00.000Z");
});
afterEach(() => setSheetsClientForTesting(null));

describe("daily import limit", () => {
  it("imports at most 200 contacts per local day, a bounded number per call, one at a time", async () => {
    await setup(manyContacts(260));
    const seen: number[] = [];
    let total = 0;
    for (let call = 0; call < 10; call++) {
      const r = await runOutreachImport(deps({ perRun: 60 }));
      seen.push(r.importedThisRun);
      total += r.importedThisRun;
    }
    expect(seen).toEqual([60, 60, 60, 20, 0, 0, 0, 0, 0, 0]);
    expect(total).toBe(200);
    expect(connections()).toHaveLength(200);
    expect(tracking()).toHaveLength(200);
    const again = await runOutreachImport(deps());
    expect(again).toMatchObject({ importedThisRun: 0, importedToday: 200, stoppedBecause: "daily-limit" });
  });

  it("the next local day continues with the remaining contacts (and only those)", async () => {
    await setup(manyContacts(230));
    for (let i = 0; i < 5; i++) await runOutreachImport(deps({ perRun: 50 }));
    expect(connections()).toHaveLength(200);
    clock = new Date("2026-11-06T05:00:00.000Z");
    const r = await runOutreachImport(deps({ perRun: 50 }));
    expect(r.importedThisRun).toBe(30);
    expect(connections()).toHaveLength(230);
    expect(new Set(tracking().map((t) => t[0])).size).toBe(230);
  });

  it("the daily limit setting can be lowered (and the day boundary is the app timezone, not UTC)", async () => {
    await setup(manyContacts(30));
    clock = new Date("2026-11-05T18:40:00.000Z"); // 00:10 on 6 Nov in IST
    const r = await runOutreachImport(deps({ dailyLimit: 5 }));
    expect(r).toMatchObject({ importedThisRun: 5, day: "2026-11-06" });
    expect(tracking().every((t) => t[6] === "2026-11-06")).toBe(true);
  });
});

describe("interruptions and cron retries", () => {
  it("a Connection that failed to save is not marked added; the next call retries that SAME contact and creates it once", async () => {
    await setup(manyContacts(5));
    let calls = 0;
    const flaky = { ...realConnectionsPort, create: async (o: MemberId, i: Parameters<typeof realConnectionsPort.create>[1]) => { if (++calls === 3) throw new Error("boom"); return realConnectionsPort.create(o, i); } };
    const r1 = await runOutreachImport(deps({ connections: flaky }));
    expect(r1).toMatchObject({ importedThisRun: 2, stoppedBecause: "error" });
    expect(connections()).toHaveLength(2);
    const rows = tracking();
    expect(rows.map((t) => t[3])).toEqual(["added", "added", "importing"]); // the failed one is NOT "added"
    expect(rows[2][11]).not.toBe("");
    const r2 = await runOutreachImport(deps());
    expect(r2.importedThisRun).toBe(3);
    expect(connections()).toHaveLength(5);
    expect(tracking().map((t) => t[3])).toEqual(Array(5).fill("added"));
    expect(new Set(tracking().map((t) => t[1])).size).toBe(5);
  });

  it("if the process dies AFTER the Connection was saved but before tracking was updated, the retry links it and creates nothing twice", async () => {
    await setup(manyContacts(3));
    const realUpdate = outreach.sheet.updateTracking.bind(outreach.sheet);
    let n = 0;
    const sheet = Object.create(outreach.sheet) as typeof outreach.sheet;
    sheet.updateTracking = async (rec) => { if (rec.importStatus === "added" && ++n === 2) throw new Error("crash after create"); return realUpdate(rec); };
    const r1 = await runOutreachImport(deps({ sheet }));
    expect(r1.stoppedBecause).toBe("error");
    expect(connections()).toHaveLength(2); // contact 2's Connection exists...
    expect(tracking().map((t) => t[3])).toEqual(["added", "importing"]); // ...but tracking still says importing
    const r2 = await runOutreachImport(deps());
    expect(connections()).toHaveLength(3); // contact 3 only; no second Connection for contact 2
    expect(tracking().map((t) => t[3])).toEqual(["added", "added", "added"]);
    expect(r2.resumed).toBe(1);
    expect(new Set(connections().map((c) => c[12])).size).toBe(3);
  });

  it("repeating a finished import changes nothing (idempotent cron retry)", async () => {
    await setup(manyContacts(8));
    await runOutreachImport(deps());
    const snapshot = JSON.stringify([connections(), tracking()]);
    const r = await runOutreachImport(deps());
    expect(r.importedThisRun).toBe(0);
    expect(JSON.stringify([connections(), tracking()])).toBe(snapshot);
  });

  it("gives up on a contact after repeated failures (import_failed) without blocking the others", async () => {
    await setup(manyContacts(3));
    const bad = { ...realConnectionsPort, create: async (o: MemberId, i: Parameters<typeof realConnectionsPort.create>[1]) => { if (i.email?.startsWith("person0000@")) throw new Error("always fails"); return realConnectionsPort.create(o, i); } };
    for (let i = 0; i < MAX_IMPORT_ATTEMPTS + 2; i++) await runOutreachImport(deps({ connections: bad }));
    const rows = tracking();
    expect(rows.find((t) => t[1].startsWith("person0000@"))![3]).toBe("import_failed");
    expect(rows.filter((t) => t[3] === "added")).toHaveLength(2);
    expect(connections()).toHaveLength(2);
  });
});

describe("duplicate prevention across automatic and manual additions", () => {
  it("a person a member already added manually is never imported again (by normalised e-mail), and is tracked as manual exactly once", async () => {
    await setup([masterRow({ PersonEmail: "dup@acme.example.com", PersonName: "Dee Dup", CompanyName: "Acme" }), ...manyContacts(2)]);
    await createConnection("rishii", createConnectionSchema.parse({ name: "D. Dup", company: "Acme", email: "  DUP@Acme.Example.com ", roleCategory: "SDE", applyRole: "Software Engineer", status: "Not Connected" }));
    const before = connections().length;
    const reg = await registerManualConnections({ sheet: outreach.sheet, connections: realConnectionsPort, now });
    expect(reg).toMatchObject({ registered: 1 });
    await runOutreachImport(deps());
    expect(connections()).toHaveLength(before + 2);
    const rows = tracking();
    expect(rows.filter((t) => t[1] === "dup@acme.example.com")).toHaveLength(1);
    expect(rows.find((t) => t[1] === "dup@acme.example.com")![2]).toBe("manual");
    expect((await registerManualConnections({ sheet: outreach.sheet, connections: realConnectionsPort, now })).registered).toBe(0);
  });

  it("a manual add AFTER an automatic import of the same address is recognised as already tracked", async () => {
    await setup([masterRow({ PersonEmail: "late@acme.example.com", PersonName: "Lee Late", CompanyName: "Acme" })]);
    await runOutreachImport(deps());
    await createConnection("lukky", createConnectionSchema.parse({ name: "Lee Late", company: "Acme", email: "late@acme.example.com", roleCategory: "SDE", applyRole: "Software Engineer", status: "Not Connected" }));
    const reg = await registerManualConnections({ sheet: outreach.sheet, connections: realConnectionsPort, now });
    expect(reg.registered).toBe(0);
    expect(tracking().filter((t) => t[1] === "late@acme.example.com")).toHaveLength(1);
  });

  it("a member adding the same person between the claim and the create is detected: the import links instead of duplicating", async () => {
    await setup([masterRow({ PersonEmail: "race@acme.example.com", PersonName: "Ray Race", CompanyName: "Acme" })]);
    let first = true;
    const racing = { ...realConnectionsPort, listFresh: async () => { const list = await realConnectionsPort.listFresh(); if (!first && !list.length) await createConnection("rishii", createConnectionSchema.parse({ name: "Ray Race", company: "Acme", email: "race@acme.example.com", roleCategory: "SDE", applyRole: "Software Engineer", status: "Not Connected" })); first = false; return realConnectionsPort.listFresh(); } };
    const r = await runOutreachImport(deps({ connections: racing }));
    expect(connections()).toHaveLength(1);
    expect(r.linkedExisting).toBe(1);
    expect(tracking()[0][3]).toBe("added");
  });

  it("ContactID and e-mail duplicates inside the sheet, mismatching ids and hand-edited e-mails are rejected, never imported", async () => {
    const good = masterRow({ PersonEmail: "ok@acme.example.com", PersonName: "Ok Person", CompanyName: "Acme" });
    const dup = masterRow({ PersonEmail: "ok@acme.example.com", PersonName: "Ok Person", CompanyName: "Acme" });
    const badId = masterRow({ PersonEmail: "badid@acme.example.com", PersonName: "Bad Id", CompanyName: "Acme" });
    badId[0] = "HRC-000000000000";
    const upper = masterRow({ PersonEmail: "upper@acme.example.com", PersonName: "Up Per", CompanyName: "Acme" });
    upper[3] = "UPPER@acme.example.com";
    await setup([good, dup, badId, upper]);
    const r = await runOutreachImport(deps());
    expect(r.masterRejected).toBe(3);
    expect(r.importedThisRun).toBe(1);
    expect(connections()).toHaveLength(1);
  });

  it("legacy ISP addresses, investors and later members of a possible-duplicate group are not imported", async () => {
    await setup([
      masterRow({ PersonEmail: "old@vsnl.net.in", PersonName: "Old Mail", CompanyName: "Old Co", EmailKind: "legacy-isp" }),
      masterRow({ PersonEmail: "angel@fund.example.com", PersonName: "Ann Angel", PersonDesignation: "Angel Investor", CompanyName: "Fund" }),
      masterRow({ PersonEmail: "a.same@twin.example.com", PersonName: "Sam Same", CompanyName: "Twin", DuplicateGroup: "DG-1" }),
      masterRow({ PersonEmail: "b.same@twin.example.com", PersonName: "Sam Same", CompanyName: "Twin", DuplicateGroup: "DG-1" }),
      masterRow({ PersonEmail: "fine@ok.example.com", PersonName: "Fi Ne", CompanyName: "Ok" }),
    ]);
    await runOutreachImport(deps());
    expect(tracking().map((t) => t[1]).sort()).toEqual(["a.same@twin.example.com", "fine@ok.example.com"]);
  });
});

describe("contact-quality segments and fallback wording", () => {
  const four = () => [
    masterRow({ PersonEmail: "both@one.example.com", PersonName: "Bo Th", CompanyName: "One Co" }),
    masterRow({ PersonEmail: "company@two.example.com", PersonName: "", CompanyName: "Two Co" }),
    masterRow({ PersonEmail: "person@three.example.com", PersonName: "Per Son", CompanyName: "" }),
    masterRow({ PersonEmail: "neither@four.example.com", PersonName: "", CompanyName: "" }),
  ];

  it("all four segments import; fallbacks appear ONLY in Connections' required name field, never in a company field or the Outreach Database", async () => {
    await setup(four());
    const before = masterBefore();
    await runOutreachImport(deps());
    expect(masterBefore()).toBe(before); // Master Contacts untouched: PersonName/CompanyName stay empty
    const byEmail = Object.fromEntries(connections().map((c) => [c[12], c]));
    expect(Object.keys(byEmail)).toHaveLength(4);
    const rows = tracking();
    expect(Object.fromEntries(rows.map((t) => [t[1], t[10]]))).toEqual({
      "both@one.example.com": "person-and-company", "company@two.example.com": "company-only", "person@three.example.com": "person-only", "neither@four.example.com": "neither",
    });
    const conns = connections();
    const nameOf = (email: string) => conns.find((c) => c[12] === email)![2];
    const companyOf = (email: string) => conns.find((c) => c[12] === email)![3];
    expect(nameOf("both@one.example.com")).toBe("Bo Th");
    expect(nameOf("company@two.example.com")).toBe("Hiring Team");
    expect(nameOf("person@three.example.com")).toBe("Per Son");
    expect(nameOf("neither@four.example.com")).toBe("Hiring Team");
    expect(companyOf("both@one.example.com")).toBe("One Co");
    expect(companyOf("person@three.example.com")).toBe("");
    expect(companyOf("neither@four.example.com")).toBe("");
    for (const c of conns) expect(c.join("|")).not.toMatch(/your company/);
  });

  it("the imported role, role basis and the not-a-verified-opening caveat are preserved, separate from outreach targeting", async () => {
    await setup([masterRow({ PersonEmail: "r@role.example.com", PersonName: "Ro Le", CompanyName: "Role Co", PrimaryRoleCategory: "AI Engineer", RoleBasis: "company-inferred", RoleVerificationStatus: "Partially Verified" })]);
    await runOutreachImport(deps());
    const c = connections()[0];
    expect(c[4]).toBe("HR Manager"); // the person's designation, untouched
    expect(c.join("\n")).toContain("AI/ML"); // roleCategory
    expect(c.join("\n")).toContain("AI Engineer"); // applyRole
    expect(c.join("\n")).toMatch(/Source: Outreach Database HRC-[0-9A-F]{12}/);
    expect(c.join("\n")).toMatch(/Role basis: company-inferred \(Partially Verified\) - a targeting choice for outreach, not a verified opening\./);
    expect(tracking()[0][12]).toBe("company-inferred");
  });
});

describe("ownership and permissions (all three members)", () => {
  it("imported Connections are shared round-robin across the three members; only the owner or the administrator can change one", async () => {
    await setup(manyContacts(9));
    await runOutreachImport(deps());
    const owners = tracking().map((t) => t[5]);
    expect(owners.filter((o) => o === "anni")).toHaveLength(3);
    expect(owners.filter((o) => o === "lukky")).toHaveLength(3);
    expect(owners.filter((o) => o === "rishii")).toHaveLength(3);
    const lukkys = tracking().find((t) => t[5] === "lukky")!;
    await expect(updateConnection("rishii", lukkys[4], { notes: "x" })).rejects.toMatchObject({ code: "not_connection_owner" });
    await expect(updateConnection("lukky", lukkys[4], { notes: "mine" })).resolves.toBeTruthy();
    await expect(updateConnection("anni", lukkys[4], { notes: "admin" })).resolves.toBeTruthy(); // Anni is the administrator
  });
});
