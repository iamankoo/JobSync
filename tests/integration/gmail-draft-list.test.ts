/**
 * Gmail Drafts list: the signed-in member's own drafts from the real NF_Drafts ledger, joined with Connections,
 * with Drafted / Sent counts that follow the ledger. In-memory sheet only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { draftListFor } from "@/lib/gmail/draft-list";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { invalidateTableCache } from "@/lib/google-sheets/table";
import { FakeSheets } from "../helpers/fake-sheets";

let sheets: FakeSheets;
const at = (min: number) => new Date(Date.UTC(2026, 9, 27, 10, min)).toISOString();
const connection = (id: string, name: string, company: string, role: string, email: string) =>
  [id, "anni", name, company, role, "", "", "", "Source: Network Finder (HN)", "Not Connected", at(0), at(0), email];
const draft = (contact: string, member: string, status: string, min: number) =>
  [`contact:${contact}:${member}`, member, "contact", contact, `gd-${contact}-${member}`, status, at(min), "", `t-${contact}`, ""];
const setStatus = (key: string, status: string) => {
  sheets.rows("NF_Drafts").find((r) => r[0] === key)![5] = status;
  invalidateTableCache();
};

beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  invalidateTableCache();
  sheets.rows("Connections").push(
    connection("conn_a", "John Smith", "Acme Technologies", "Head of Engineering", "john@acme.example"),
    connection("conn_b", "Priya Sharma", "Globex", "Technical Recruiter", "priya@globex.example"),
    connection("conn_c", "Sam Lee", "Initech", "Founder", ""),
  );
});
afterEach(() => setSheetsClientForTesting(null));

describe("draftListFor", () => {
  it("is empty (the page shows 'Drafts are coming soon') before any draft exists", async () => {
    expect(await draftListFor("anni")).toEqual({ setUp: true, drafted: 0, sent: 0, items: [] });
  });

  it("lists MY drafts with company, person, designation, email and status — newest first, never another member's", async () => {
    sheets.rows("NF_Drafts").push(
      draft("conn_a", "anni", "created", 1), draft("conn_b", "anni", "created", 2), draft("conn_c", "anni", "created", 3),
      draft("conn_a", "lukky", "created", 1), draft("conn_a", "rishii", "sent", 1),
    );
    const list = await draftListFor("anni");
    expect([list.drafted, list.sent]).toEqual([3, 0]);
    expect(list.items.map((i) => [i.company, i.person, i.designation, i.email, i.status])).toEqual([
      ["Initech", "Sam Lee", "Founder", "", "Drafted"],
      ["Globex", "Priya Sharma", "Technical Recruiter", "priya@globex.example", "Drafted"],
      ["Acme Technologies", "John Smith", "Head of Engineering", "john@acme.example", "Drafted"],
    ]);
    expect(list.items.every((i) => i.draftKey.endsWith(":anni"))).toBe(true);
    expect((await draftListFor("lukky")).items).toHaveLength(1);
    expect(await draftListFor("rishii")).toMatchObject({ drafted: 0, sent: 1 });
  });

  it("counts follow the real state: 3/0 → one sent → 2/1 → a new draft → 3/1", async () => {
    sheets.rows("NF_Drafts").push(draft("conn_a", "anni", "created", 1), draft("conn_b", "anni", "created", 2), draft("conn_c", "anni", "created", 3));
    expect(await draftListFor("anni")).toMatchObject({ drafted: 3, sent: 0 });
    setStatus("contact:conn_a:anni", "sent"); // what the sent-draft tracker writes when Gmail shows it sent
    const after = await draftListFor("anni");
    expect(after).toMatchObject({ drafted: 2, sent: 1 });
    expect(after.items.find((i) => i.person === "John Smith")!.status).toBe("Sent");
    sheets.rows("Connections").push(connection("conn_d", "Ana Ruiz", "Umbrella", "CTO", "ana@umbrella.example"));
    sheets.rows("NF_Drafts").push(draft("conn_d", "anni", "created", 4));
    invalidateTableCache();
    expect(await draftListFor("anni")).toMatchObject({ drafted: 3, sent: 1 });
  });

  it("does not list deleted, skipped or failed drafts (they are not in Gmail as drafts or sent mail)", async () => {
    sheets.rows("NF_Drafts").push(draft("conn_a", "anni", "deleted", 1), draft("conn_b", "anni", "skipped_unauthorized", 2), draft("conn_c", "anni", "failed", 3));
    expect(await draftListFor("anni")).toEqual({ setUp: true, drafted: 0, sent: 0, items: [] });
  });

  it("is safe when the tabs are missing or a contact was removed", async () => {
    sheets.rows("NF_Drafts").push(draft("conn_gone", "anni", "created", 1));
    expect((await draftListFor("anni")).items[0]).toMatchObject({ company: "", person: "", status: "Drafted" });
    sheets.tabs.delete("NF_Drafts");
    invalidateTableCache();
    expect(await draftListFor("anni")).toEqual({ setUp: false, drafted: 0, sent: 0, items: [] });
  });
});
