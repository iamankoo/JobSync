/**
 * Dry run against the REAL master data (the local export of the Outreach Database). Reads only; skipped when the export is absent
 * (it is untracked local data). Nothing is imported, written or sent.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCsv } from "@/lib/hr-master/csv";
import { MASTER_FIELDS } from "@/lib/hr-master/types";
import { fallbacksConsistent, firstInDuplicateGroups, importEligibility, importOrder, parseMasterRows, segmentOf } from "@/lib/outreach/contacts";
import { connectionInputFor } from "@/lib/outreach/importer";
import { createConnectionSchema } from "@/lib/validation/connections";

const file = path.resolve(import.meta.dirname, "../../../data/hr-master/master-contacts.csv");
const present = fs.existsSync(file);

describe.skipIf(!present)("real Outreach Database master data (dry run)", () => {
  const grid = present ? parseCsv(fs.readFileSync(file, "utf8")) : [];
  const parsed = present ? parseMasterRows(grid) : { contacts: [], rejected: [] };

  it("has the full schema header and every one of the 15,891 rows parses (none rejected)", () => {
    expect(grid[0]).toEqual([...MASTER_FIELDS]);
    expect(parsed.rejected).toEqual([]);
    expect(parsed.contacts).toHaveLength(15891);
    expect(new Set(parsed.contacts.map((c) => c.contactId)).size).toBe(15891);
  });

  it("preserves the four contact-quality segments exactly", () => {
    const count = { "person-and-company": 0, "company-only": 0, "person-only": 0, neither: 0 };
    for (const c of parsed.contacts) count[segmentOf(c)] += 1;
    expect(count).toEqual({ "person-and-company": 10260, "company-only": 5056, "person-only": 19, neither: 556 });
  });

  it("the stored Hiring Team / your company fallbacks agree with the rule on every row, and the role distribution is preserved", () => {
    expect(parsed.contacts.every(fallbacksConsistent)).toBe(true);
    const roles: Record<string, number> = {};
    for (const c of parsed.contacts) roles[c.primaryRoleCategory] = (roles[c.primaryRoleCategory] ?? 0) + 1;
    expect(roles["AI Engineer"]).toBe(1666);
    expect(roles["Software Engineer"]).toBe(10895);
    expect(Object.entries(roles).filter(([k]) => k !== "AI Engineer" && k !== "Software Engineer").reduce((n, [, v]) => n + v, 0)).toBe(3330);
  });

  it("every eligible contact converts to a valid Connections input; the first 200 are a sensible, deterministic day", () => {
    const first = firstInDuplicateGroups(parsed.contacts);
    const eligible = parsed.contacts.filter((c) => importEligibility(c, first).eligible).sort(importOrder);
    expect(eligible.length).toBeGreaterThan(15000);
    for (const c of eligible) expect(() => createConnectionSchema.parse(connectionInputFor(c)), c.contactId).not.toThrow();
    const day1 = eligible.slice(0, 200);
    expect(day1.every((c) => segmentOf(c) === "person-and-company" && c.emailKind === "company")).toBe(true);
    expect(eligible.slice(0, 200).map((c) => c.contactId)).toEqual([...eligible].sort(importOrder).slice(0, 200).map((c) => c.contactId));
    // the exclusions are visible and small
    const excluded = parsed.contacts.filter((c) => !importEligibility(c, first).eligible);
    expect(excluded.length).toBe(parsed.contacts.length - eligible.length);
  });
});
