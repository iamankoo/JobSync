import { describe, expect, it } from "vitest";
import { dedupe } from "@/lib/hr-master/dedupe";
import { extractCompaniesMd, extractDataJson, extractPdfPages, extractUnifiedCsv, extractXlsxRows } from "@/lib/hr-master/extract";
import { contactIdFor } from "@/lib/hr-master/ids";
import { parseCsv } from "@/lib/hr-master/csv";

const CSV = `Company,Email,Person,Title,Location,Source,Notes
Acme Software,Jane.Doe@acme.com,Jane Doe,HR Manager,Pune,industry/a.csv,"alt: jane@acme-hr.com"
,solo@startup.io,,,,industry/b.csv,
Gmail Person Co,someone@gmail.com,Some One,Recruiter,,industry/c.csv,
Bad Row,not-an-email,Bad,HR,,industry/d.csv,
No Email Row,,Nobody,HR,,industry/e.csv,
`;
const JSON_TEXT = JSON.stringify([
  { SNo: 1, Name: "Jane Doe", Email: "jane.doe@acme.com", Title: "Head of HR", Company: "Acme Software Pvt Ltd" },
  { SNo: 2, Name: "Raj Kumar", Email: "raj@acme.com", Title: "Recruiter", Company: "Acme Software" },
]);
const XLSX_ROWS = [
  ["SNo", "Name", "Email", "Title", "Company"],
  ["1", "Jane Doe", "JANE.DOE@ACME.COM", "HR Manager", "Acme Software"],
  ["2", "Wei Chen", "wei@globex.com", "", "Globex"],
];
const MD = `# Big Tech Contacts

| Company | Domain | Role Email | Department / Team | Location | Description | Source URL | Last Verified |
|---|---|---|---|---|---|---|---|
| Globex | globex.com | careers@globex.com | For Employment | Global | Makes things. | https://globex.com/careers | 2025-10-18 |
`;
const PDF_PAGES = [
  "FAMOUS IT COMPANIES HR E-MAIL ID\n\nInitech  \njobs@initech.com  \n Bangalore  \n\nHooli\nhr@hooli.com\njobs@hooli.com\n",
  " Chennai\nPiedPiper\nresumes@piedpiper.net\n",
];

describe("extraction from all five source formats", () => {
  it("csv: keeps every row (valid or not) with original values and row numbers", () => {
    const r = extractUnifiedCsv(CSV);
    expect(r.format).toBe("csv");
    expect(r.records).toHaveLength(5);
    expect(r.records[0]).toMatchObject({ sourceFile: "unified_emails.csv", sourceLocation: "row 2", company: "Acme Software", name: "Jane Doe", designation: "HR Manager" });
    expect(r.records[0].original.Email).toBe("Jane.Doe@acme.com");
    expect(r.records[4].email).toBe("");
  });

  it("json: reads records with SNo in the location", () => {
    const r = extractDataJson(JSON_TEXT);
    expect(r.records).toHaveLength(2);
    expect(r.records[0].sourceLocation).toBe("record 1 (SNo 1)");
    expect(r.records[1].email).toBe("raj@acme.com");
  });

  it("xlsx rows: uses the header and sheet name in the location", () => {
    const r = extractXlsxRows(XLSX_ROWS);
    expect(r.records).toHaveLength(2);
    expect(r.records[0].sourceLocation).toBe('sheet "HR List" row 2');
    expect(r.records[1].designation).toBe("");
  });

  it("markdown: reads the table as role mailboxes with the domain hint and a no-person uncertainty", () => {
    const r = extractCompaniesMd(MD);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ email: "careers@globex.com", domainHint: "globex.com", company: "Globex", name: "", sourceLocation: "line 5" });
    expect(r.records[0].uncertainties.join(" ")).toMatch(/no individual person/);
  });

  it("pdf: infers the company from the preceding heading, flags it, and attaches the city", () => {
    const r = extractPdfPages(PDF_PAGES);
    expect(r.records.map((x) => [x.email, x.company])).toEqual([
      ["jobs@initech.com", "Initech"],
      ["hr@hooli.com", "Hooli"],
      ["jobs@hooli.com", "Hooli"],
      ["resumes@piedpiper.net", "PiedPiper"],
    ]);
    expect(r.records[0].context.location).toBe("Bangalore");
    expect(r.records[0].uncertainties[0]).toMatch(/inferred/);
    expect(r.records[0].sourceLocation).toBe("page 1 line 4");
  });
});

describe("csv parser", () => {
  it("handles quotes, embedded commas/newlines, doubled quotes and a BOM", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n"l1\nl2",z\r\n')).toEqual([["a", "b"], ["x, y", 'say "hi"'], ["l1\nl2", "z"]]);
  });
});

describe("deduplication", () => {
  const records = [
    ...extractUnifiedCsv(CSV).records,
    ...extractDataJson(JSON_TEXT).records,
    ...extractXlsxRows(XLSX_ROWS).records,
    ...extractCompaniesMd(MD).records,
    ...extractPdfPages(PDF_PAGES).records,
  ];
  const result = dedupe(records);

  it("accounts for every raw record and separates invalid ones with a reason", () => {
    expect(result.stats.rawTotal).toBe(records.length);
    expect(result.invalid.map((i) => i.reason)).toEqual(["must contain exactly one @", "empty"]);
    expect(result.stats.validEmailRecords + result.stats.invalidRecords).toBe(records.length);
    expect(result.stats.uniqueContacts + result.stats.duplicateRecordsMerged).toBe(result.stats.validEmailRecords);
  });

  it("merges the same e-mail across files (case-insensitively) into ONE contact and keeps every source reference", () => {
    const jane = result.contacts.find((c) => c.email === "jane.doe@acme.com")!;
    expect(result.contacts.filter((c) => c.email === "jane.doe@acme.com")).toHaveLength(1);
    expect(jane.rawCount).toBe(3);
    expect(jane.sources.map((s) => `${s.file}:${s.location}`).sort()).toEqual([
      'HR_List_2026.xlsx:sheet "HR List" row 2',
      "data.json:record 1 (SNo 1)",
      "unified_emails.csv:row 2",
    ]);
    expect(jane.originals).toHaveLength(3);
    expect(jane.originals.some((o) => o.values.Email === "Jane.Doe@acme.com")).toBe(true);
  });

  it("documents conflicting values instead of discarding them, preferring the higher-priority source", () => {
    const jane = result.contacts.find((c) => c.email === "jane.doe@acme.com")!;
    const des = jane.conflicts.find((c) => c.field === "PersonDesignation")!;
    expect(des.chosen).toBe("Head of HR"); // data.json outranks the csv/xlsx
    expect(des.values.map((v) => v.value).sort()).toEqual(["HR Manager", "Head of HR"]);
    expect(jane.company).toBe("Acme Software Pvt Ltd");
    expect(jane.conflicts.some((c) => c.field === "CompanyName")).toBe(false); // same company, different wording
  });

  it("keeps fields that are missing missing (no invented company/designation)", () => {
    const solo = result.contacts.find((c) => c.email === "solo@startup.io")!;
    expect(solo).toMatchObject({ name: "", designation: "", company: "", emailKind: "company", contactKind: "unknown" });
    const wei = result.contacts.find((c) => c.email === "wei@globex.com")!;
    expect(wei.designation).toBe("");
  });

  it("classifies public providers and role mailboxes", () => {
    expect(result.contacts.find((c) => c.email === "someone@gmail.com")).toMatchObject({ emailKind: "public-provider", contactKind: "person" });
    expect(result.contacts.find((c) => c.email === "careers@globex.com")?.contactKind).toBe("role-mailbox");
  });

  it("records a declared alternate address on the same contact", () => {
    expect(result.contacts.find((c) => c.email === "jane.doe@acme.com")?.alternateEmails).toEqual(["jane@acme-hr.com"]);
  });

  it("repairs stray whitespace in an address and notes it", () => {
    const r = dedupe(extractDataJson(JSON.stringify([{ SNo: 1, Name: "Gita Rao", Email: "gita.rao@corp. com", Title: "HR", Company: "Corp" }])).records);
    expect(r.contacts[0].email).toBe("gita.rao@corp.com");
    expect(r.contacts[0].uncertainties.join(" ")).toMatch(/whitespace/);
  });

  it("never merges different people who merely share a name or a company domain", () => {
    const people = dedupe([
      ...extractDataJson(JSON.stringify([
        { SNo: 1, Name: "Anil Rao", Email: "anil.rao@one.com", Title: "HR", Company: "One" },
        { SNo: 2, Name: "Anil Rao", Email: "anil.rao@two.com", Title: "HR", Company: "Two" },
        { SNo: 3, Name: "Priya Nair", Email: "priya@one.com", Title: "HR", Company: "One" },
        { SNo: 4, Name: "Priya Nair", Email: "p.nair@one.com", Title: "TA", Company: "One" },
      ])).records,
    ]);
    expect(people.contacts).toHaveLength(4);
    expect(people.stats.sameNameDifferentCompanyNames).toBe(1); // Anil Rao at two companies: different people, no flag
    expect(people.groups).toHaveLength(1); // Priya Nair at the same company, different address: review, not merged
    expect(people.groups[0].emails.sort()).toEqual(["p.nair@one.com", "priya@one.com"]);
  });

  it("ignores spreadsheet-formula residue and domain-like values as names/companies", () => {
    const r = dedupe(extractUnifiedCsv("Company,Email,Person,Title\n=A2318,x@acs-inc.com,acs-inc,HR\n").records);
    expect(r.contacts[0].company).toBe("");
    expect(r.contacts[0].name).toBe("");
  });

  it("is deterministic and order independent", () => {
    const a = dedupe(records);
    const b = dedupe([...records].reverse());
    expect(b.contacts.map((c) => c.email)).toEqual(a.contacts.map((c) => c.email));
    expect(b.stats.uniqueContacts).toBe(a.stats.uniqueContacts);
  });
});

describe("ContactID", () => {
  it("is stable, derived only from the normalised e-mail, and well formed", () => {
    expect(contactIdFor("jane.doe@acme.com")).toBe(contactIdFor("jane.doe@acme.com"));
    expect(contactIdFor("jane.doe@acme.com")).toMatch(/^HRC-[0-9A-F]{12}$/);
    expect(contactIdFor("a@x.com")).not.toBe(contactIdFor("b@x.com"));
    const ids = dedupe(extractDataJson(JSON_TEXT).records).contacts.map((c) => contactIdFor(c.email));
    expect(ids).toEqual(dedupe(extractDataJson(JSON_TEXT).records).contacts.map((c) => contactIdFor(c.email)));
  });
});
