import { describe, expect, it } from "vitest";
import {
  parseActivityRow, parseApplicationRow, parseJobRow, parseMemberRow, serializeActivity, serializeApplication, serializeJob,
} from "@/lib/google-sheets/rows";
import { headerProblems } from "@/lib/google-sheets/table";
import { TABS } from "@/lib/google-sheets/schema";

const jobCells = ["job_1", "Synthetic Co A", "SWE", "Full-time", "Hybrid", "0-2 years", "₹20 LPA", "Testville", "https://example.test/j/1", "2026-11-01", "desc", "anni", "2026-10-09T10:00:00.000Z"];

describe("parseJobRow", () => {
  it("parses a complete row and round-trips through serializeJob", () => {
    const r = parseJobRow(jobCells);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings).toEqual([]);
      expect(r.value.workMode).toBe("Hybrid");
      expect(serializeJob(r.value)).toEqual(jobCells);
    }
  });

  it.each([
    ["JobID", 0, ""], ["Company", 1, " "], ["JobRole", 2, ""], ["JobType", 3, "Volunteer"], ["Location", 7, ""],
    ["JobURL", 8, "not a url"], ["AddedBy", 11, "mallory"], ["AddedAt", 12, "yesterday"],
  ])("skips a row with bad %s", (_n, idx, value) => {
    const cells = [...jobCells];
    cells[idx as number] = value as string;
    expect(parseJobRow(cells).ok).toBe(false);
  });

  it("keeps the row but drops invalid optional fields with warnings", () => {
    const cells = [...jobCells];
    cells[4] = "Underwater";
    cells[9] = "next friday";
    const r = parseJobRow(cells);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.workMode).toBeUndefined();
      expect(r.value.deadline).toBeUndefined();
      expect(r.warnings).toHaveLength(2);
    }
  });

  it("tolerates short rows and stray whitespace", () => {
    expect(parseJobRow(["job_1", "G", "R"].concat(Array(10).fill(""))).ok).toBe(false);
    const padded = jobCells.map((c) => `  ${c}  `);
    expect(parseJobRow(padded).ok).toBe(true);
  });
});

describe("parseApplicationRow", () => {
  const cells = ["job_1", "lukky", "Applied", "2026-10-09T10:00:00.000Z", "Screening", "note", "2026-10-09T11:00:00.000Z"];
  it("parses and round-trips", () => {
    const r = parseApplicationRow(cells);
    expect(r.ok).toBe(true);
    if (r.ok) expect(serializeApplication(r.value, false)).toEqual(cells);
  });
  it("rejects unknown members, statuses and missing LastUpdated", () => {
    expect(parseApplicationRow(["job_1", "bob", "Applied", "", "", "", "2026-10-09T11:00:00.000Z"]).ok).toBe(false);
    expect(parseApplicationRow(["job_1", "anni", "Hired", "", "", "", "2026-10-09T11:00:00.000Z"]).ok).toBe(false);
    expect(parseApplicationRow(["job_1", "anni", "Applied", "", "", "", ""]).ok).toBe(false);
  });
  it("drops an invalid stage or AppliedAt with warnings", () => {
    const r = parseApplicationRow(["job_1", "anni", "Applied", "yesterday", "Lunch", "", "2026-10-09T11:00:00.000Z"]);
    expect(r.ok && r.warnings.length).toBe(2);
  });
});

describe("parseMemberRow / parseActivityRow", () => {
  it("members: accepts TRUE/FALSE variants and uses configuration as identity authority", () => {
    const r = parseMemberRow(["anni", "Someone Else", "/x.png", "true"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe("Anni");
      expect(r.value.photo).toBe("/assets/anni.jpeg");
      expect(r.value.active).toBe(true);
      expect(r.warnings).toHaveLength(1);
    }
    const off = parseMemberRow(["lukky", "Lukky", "", "FALSE"]);
    expect(off.ok && off.value.active).toBe(false);
    expect(parseMemberRow(["eve", "Eve", "", "TRUE"]).ok).toBe(false);
    expect(parseMemberRow(["anni", "Anni", "", "maybe"]).ok).toBe(false);
  });

  it("activity: validates every field and round-trips", () => {
    const cells = ["act_1", "rishii", "2026-10-09", "job_added", "job_1", "2026-10-09T10:00:00.000Z"];
    const r = parseActivityRow(cells);
    expect(r.ok).toBe(true);
    if (r.ok) expect(serializeActivity(r.value)).toEqual(cells);
    expect(parseActivityRow([...cells.slice(0, 3), "deleted_everything", ...cells.slice(4)]).ok).toBe(false);
    expect(parseActivityRow([cells[0], cells[1], "09/10/2026", ...cells.slice(3)]).ok).toBe(false);
    expect(parseActivityRow(["act_1", "rishii", "2026-10-09", "job_added", "", "2026-10-09T10:00:00.000Z"]).ok).toBe(true);
  });
});

describe("headerProblems", () => {
  it("accepts exact headers (trimmed) and reports every wrong column", () => {
    expect(headerProblems("applications", [...TABS.applications.headers])).toEqual([]);
    expect(headerProblems("members", TABS.members.headers.map((h) => ` ${h} `))).toEqual([]);
    const wrong: string[] = [...TABS.jobs.headers];
    wrong[2] = "Role";
    wrong[8] = "";
    expect(headerProblems("jobs", wrong)).toHaveLength(2);
  });
  it("reports an empty tab and wrong order", () => {
    expect(headerProblems("jobs", undefined)).toHaveLength(1);
    expect(headerProblems("jobs", [])).toHaveLength(1);
    expect(headerProblems("activity", ["MemberID", "ActivityID", "Date", "Action", "JobID", "Timestamp"]).length).toBe(2);
  });
});
