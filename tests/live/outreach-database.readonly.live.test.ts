/**
 * LIVE, READ-ONLY verification against the REAL Outreach Database and the real member resume uploads (production MemberFiles).
 * Every client used here throws on any write, so this file cannot change anything. Run with:
 *   OUTREACH_SPREADSHEET_ID=<id> npx vitest run --config vitest.live.config.mts tests/live/outreach-database.readonly.live.test.ts
 * Skipped without OUTREACH_SPREADSHEET_ID and credentials. Prints nothing personal; counts and decisions only.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MEMBER_IDS } from "@/config/members";
import { MEMBER_RESUME_FILES, RESUME_KINDS, planResume, resumeKindForRole } from "@/config/resume-map";
import { createGoogleClient, type SheetsClient } from "@/lib/google-sheets/client";
import { normalizePrivateKey } from "@/lib/google-sheets/config";
import { firstInDuplicateGroups, importEligibility, importOrder, parseMasterRows, segmentOf } from "@/lib/outreach/contacts";
import { COUNTER_HEADERS, EXCLUSION_HEADERS, SEND_LEDGER_HEADERS, STATE_HEADERS, TRACKING_HEADERS } from "@/lib/outreach/headers";
import { OutreachSheet } from "@/lib/outreach/sheet";
import { COUNTERS_TAB, EXCLUSIONS_TAB, SEND_LEDGER_TAB, STATE_TAB, TRACKING_TAB } from "@/lib/outreach/types";
import { parseEnvFile } from "../helpers/live-env";

const root = path.resolve(__dirname, "..", "..");
const env = { ...parseEnvFile(path.join(root, ".env.local")), ...process.env } as Record<string, string | undefined>;
const outreachId = env.OUTREACH_SPREADSHEET_ID?.trim();
const prodId = env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim();
const email = env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
const key = env.GOOGLE_PRIVATE_KEY;
const available = Boolean(outreachId && prodId && email && key && outreachId !== prodId);

/** A client that can only read. */
function readOnly(spreadsheetId: string): SheetsClient {
  const real = createGoogleClient({ spreadsheetId, clientEmail: email!, privateKey: normalizePrivateKey(key!) });
  const refuse = () => { throw new Error("READ-ONLY test: writes are forbidden"); };
  return { getValues: (r) => real.getValues(r), appendValues: refuse, updateValues: refuse, deleteRows: refuse } as SheetsClient;
}

describe.skipIf(!available)("Outreach Database (real, read-only)", () => {
  const sheet = () => new OutreachSheet(readOnly(outreachId!));

  it("Master Contacts holds the expected 15,891 records and every row parses (none rejected)", async () => {
    const parsed = parseMasterRows(await sheet().readMaster());
    expect(parsed.rejected).toEqual([]);
    expect(parsed.contacts).toHaveLength(15891);
    expect(new Set(parsed.contacts.map((c) => c.contactId)).size).toBe(15891);
    expect(new Set(parsed.contacts.map((c) => c.personEmail)).size).toBe(15891);
  });

  it("preserves the four contact-quality segments and the role distribution", async () => {
    const { contacts } = parseMasterRows(await sheet().readMaster());
    const seg = { "person-and-company": 0, "company-only": 0, "person-only": 0, neither: 0 };
    const roles: Record<string, number> = {};
    for (const c of contacts) { seg[segmentOf(c)] += 1; roles[c.primaryRoleCategory] = (roles[c.primaryRoleCategory] ?? 0) + 1; }
    expect(seg).toEqual({ "person-and-company": 10260, "company-only": 5056, "person-only": 19, neither: 556 });
    expect(roles["AI Engineer"]).toBe(1666);
    expect(roles["Software Engineer"]).toBe(10895);
    expect(contacts.every((c) => c.salutationName === (c.personName || "Hiring Team") && c.companyReference === (c.companyName || "your company"))).toBe(true);
  });

  it("eligibility and import order: 15,624 eligible; the first day's 200 are the best-identified company contacts", async () => {
    const { contacts } = parseMasterRows(await sheet().readMaster());
    const first = firstInDuplicateGroups(contacts);
    const eligible = contacts.filter((c) => importEligibility(c, first).eligible).sort(importOrder);
    expect(eligible).toHaveLength(15624);
    expect(eligible.slice(0, 200).every((c) => segmentOf(c) === "person-and-company" && c.emailKind === "company")).toBe(true);
  });

  it("the outreach tabs exist with exactly the expected headers, and nothing has been imported, drafted or sent yet", async () => {
    const client = readOnly(outreachId!);
    for (const [tab, headers] of [[TRACKING_TAB, TRACKING_HEADERS], [COUNTERS_TAB, COUNTER_HEADERS], [STATE_TAB, STATE_HEADERS], [SEND_LEDGER_TAB, SEND_LEDGER_HEADERS], [EXCLUSIONS_TAB, EXCLUSION_HEADERS]] as const) {
      const grid = await client.getValues(`'${tab}'!A:AZ`);
      expect(grid[0]?.slice(0, headers.length), tab).toEqual([...headers]);
      expect(grid.length - 1, `${tab} data rows`).toBe(0);
    }
  });

  it("resume selection against the REAL uploads: each member's own files only, with the documented same-member SDE fallback", async () => {
    const grid = await readOnly(prodId!).getValues("MemberFiles!A:H");
    const uploads = grid.slice(1).filter((r) => r[2] === "resume").map((r) => ({ member: r[1], fileName: r[4], mimeType: r[5] }));
    const decisions: Record<string, Record<string, string>> = {};
    for (const m of MEMBER_IDS) {
      const mine = uploads.filter((u) => u.member === m).map(({ fileName, mimeType }) => ({ fileName, mimeType }));
      decisions[m] = {};
      for (const role of ["AI Engineer", "Software Engineer", "Backend Engineer", "Full Stack Engineer", "Front End Developer", "DevOps Engineer", "Data Engineer", "Data Analyst"]) {
        const d = planResume(m, role, mine);
        decisions[m][role] = d.status === "use" ? `${d.fileName}${d.fallbackFrom ? ` (SDE fallback for ${d.fallbackFrom})` : ""}` : `NONE: ${d.reason}`;
        if (d.status === "use") {
          expect(Object.values(MEMBER_RESUME_FILES[m]), `${m}/${role}`).toContain(d.fileName); // never another member's file
          expect(mine.filter((u) => u.fileName.toLowerCase() === d.fileName.toLowerCase())).toHaveLength(1); // unambiguous
        }
      }
      expect(decisions[m]["Software Engineer"], `${m} has an SDE resume`).not.toMatch(/^NONE/);
    }
    expect(RESUME_KINDS).toHaveLength(5);
    expect(resumeKindForRole("Data Analyst")).toBe("Data");
    fs.writeFileSync(path.join(root, "test-results", "resume-decisions.json"), JSON.stringify(decisions, null, 1));
  });
});
