/**
 * Tooling for a CONTROLLED live test of the outreach pipeline: generates 10 clearly labelled test contacts for an isolated tab, and
 * (the removal lives in src/lib/outreach/test-cleanup.ts and runs on the server). The cleanup can only touch rows that provably belong to the test (their ContactIDs /
 * addresses are derived from the generated contacts); real rows are never selected.
 */
import { testEmail } from "@/lib/outreach/test-cleanup";
import { masterRow } from "./outreach";

export const TEST_TAB = "Test Contacts";
export const TEST_LABEL = "TEST ENTRY";

const ROLES = [
  "AI Engineer", "AI/ML Engineer", "Software Engineer", "Software Engineer", "Backend Engineer",
  "Full Stack Engineer", "Front End Developer / Engineer", "Data Engineer", "Software Engineer", "Software Engineer",
] as const;

/**
 * Ten test contacts. Names and companies are labelled "JobSync Test NN" / "JobSync TEST Company NN". Contact 09 has no person name
 * (exercises "Hiring Team") and contact 10 has no company (exercises "your company"). Roles vary so several resume kinds are exercised.
 */
export function buildTestContactRows(local: string, domain: string): string[][] {
  return ROLES.map((role, k) => {
    const n = k + 1;
    const nn = String(n).padStart(2, "0");
    return masterRow({
      PersonEmail: testEmail(local, domain, n),
      PersonName: n === 9 ? "" : `JobSync Test ${nn}`,
      PersonDesignation: `${TEST_LABEL} - recruiter`,
      CompanyName: n === 10 ? "" : `JobSync TEST Company ${nn}`,
      CompanyDescription: n === 10 ? "" : `${TEST_LABEL} created to verify JobSync outreach; safe to delete.`,
      PrimaryRoleCategory: role,
      RoleBasis: "default-fallback",
      ResearchNotes: `${TEST_LABEL}: controlled test of the outreach pipeline`,
      EmailKind: "public-provider",
    });
  });
}

export { cleanupTestArtifacts, testContactIds, testEmail, testEmails } from "@/lib/outreach/test-cleanup";
export type { CleanupPorts, CleanupReport } from "@/lib/outreach/test-cleanup";
