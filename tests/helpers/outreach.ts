import { contactIdFor } from "@/lib/hr-master/ids";
import { MASTER_FIELDS } from "@/lib/hr-master/types";
import { OutreachSheet } from "@/lib/outreach/sheet";
import { COUNTERS_TAB, EXCLUSIONS_TAB, MASTER_TAB, SEND_LEDGER_TAB, STATE_TAB, TRACKING_TAB } from "@/lib/outreach/types";
import { FakeSheets } from "./fake-sheets";

/** A complete Master Contacts row (all 32 columns) for tests; ContactID is derived from the e-mail exactly as in Part 1. */
export function masterRow(over: Partial<Record<(typeof MASTER_FIELDS)[number], string>> & { PersonEmail: string }): string[] {
  const email = over.PersonEmail.toLowerCase();
  const company = over.CompanyName ?? "";
  const person = over.PersonName ?? "";
  const base: Record<string, string> = {
    ContactID: contactIdFor(email), PersonName: person, PersonDesignation: "HR Manager", PersonEmail: email, EmailDomain: email.split("@")[1],
    CompanyName: company, CompanyURL: company ? `https://${email.split("@")[1]}` : "", CompanyDomain: "", PrimaryRoleCategory: "Software Engineer",
    AdditionalRoleCategories: "", CompanyDescription: company ? `${company} builds software for retail teams.` : "", HiringEvidence: "DEFAULT FALLBACK",
    PersonVerificationStatus: "Unverified", CompanyVerificationStatus: company ? "Verified" : "Unverified", RoleVerificationStatus: "Unverified",
    ResearchSources: "", SourceFiles: "data.json", SourceLocations: "data.json: record 1", DuplicateGroup: "", ResearchNotes: "", LastResearchedAt: "",
    ContactKind: person ? "person" : "role-mailbox", EmailKind: "company", AlternateEmails: "", CareersURL: "", PersonEvidence: "", Conflicts: "[]",
    ResolutionStatus: "resolved", RoleBasis: "default-fallback", SalutationName: person || "Hiring Team", CompanyReference: company || "your company", SchemaVersion: "2",
  };
  return MASTER_FIELDS.map((f) => String(over[f] ?? base[f] ?? ""));
}

export const masterGrid = (rows: string[][]): string[][] => [[...MASTER_FIELDS], ...rows];

/** A fake Outreach Database spreadsheet: Master Contacts plus the three (blank) tracking tabs. */
export function newOutreachSpreadsheet(master: string[][]): { fake: FakeSheets; sheet: OutreachSheet } {
  const fake = new FakeSheets(false);
  fake.tabs.set(MASTER_TAB, master);
  for (const t of [TRACKING_TAB, COUNTERS_TAB, STATE_TAB, SEND_LEDGER_TAB, EXCLUSIONS_TAB]) fake.tabs.set(t, [[]]);
  return { fake, sheet: new OutreachSheet(fake) };
}

/** n distinct eligible contacts (company e-mails at distinct domains). */
export function manyContacts(n: number, seg: "full" | "company-only" = "full"): string[][] {
  return Array.from({ length: n }, (_, i) =>
    masterRow({
      PersonEmail: `person${String(i).padStart(4, "0")}@company${i}.example.com`,
      PersonName: seg === "full" ? `Person Number${i}` : "",
      CompanyName: `Company ${i}`,
    }),
  );
}
