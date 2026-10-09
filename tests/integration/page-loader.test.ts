import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  }),
}));

import { getSession } from "@/lib/auth/session";
import { loadForMember } from "@/lib/pages/load";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { createJob, listJobsForMember } from "@/lib/google-sheets/jobs-service";
import { listMyApplications, setApplicationStatus } from "@/lib/google-sheets/applications-service";
import type { MemberId } from "@/config/members";
import { FakeSheets, googleError } from "../helpers/fake-sheets";

let sheets: FakeSheets;
const as = (m: MemberId | null) => vi.mocked(getSession).mockResolvedValue(m ? { memberId: m, expiresAt: 9_999_999_999 } : null);
const NOW = new Date("2026-10-09T10:00:00Z");

beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
});
afterEach(() => {
  setSheetsClientForTesting(null);
  vi.mocked(getSession).mockReset();
});

describe("loadForMember (server pages)", () => {
  it("redirects to /login without a valid session, before touching Sheets", async () => {
    as(null);
    await expect(loadForMember(listJobsForMember)).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(sheets.calls).toHaveLength(0);
  });

  it("passes the SESSION member to the loader and returns real data (empty sheet gives empty data, not samples)", async () => {
    as("lukky");
    const seen: string[] = [];
    const ctx = await loadForMember(async (m) => {
      seen.push(m);
      return listJobsForMember(m);
    });
    expect(seen).toEqual(["lukky"]);
    expect(ctx.memberId).toBe("lukky");
    expect(ctx.timeZone).toBeTruthy();
    expect(ctx.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ctx.result).toEqual({ ok: true, data: { jobs: [], skippedRows: 0 } });
  });

  it("each member sees the same shared jobs but only their own application data", async () => {
    const jobId = (await createJob("anni", { company: "Synthetic Co", jobRole: "Test Role", jobType: "Internship", location: "Testville", jobUrl: "https://jobs.example.test/1" }, NOW)).jobId;
    await setApplicationStatus("anni", jobId, { status: "Applied" }, NOW);

    as("anni");
    const anni = await loadForMember(listJobsForMember);
    as("lukky");
    const lukky = await loadForMember(listJobsForMember);
    expect(anni.result.ok && anni.result.data.jobs.map((j) => [j.jobId, j.myStatus])).toEqual([[jobId, "Applied"]]);
    expect(lukky.result.ok && lukky.result.data.jobs.map((j) => [j.jobId, j.myStatus])).toEqual([[jobId, "Not Applied"]]);

    as("anni");
    const mineAnni = await loadForMember(listMyApplications);
    as("lukky");
    const mineLukky = await loadForMember(listMyApplications);
    expect(mineAnni.result.ok && mineAnni.result.data.rows).toHaveLength(1);
    expect(mineLukky.result.ok && mineLukky.result.data.rows).toHaveLength(0);
  });

  it("returns a safe 'not active' result for deactivated members and does not run the loader", async () => {
    sheets = new FakeSheets().seedMembers({ rishii: false });
    setSheetsClientForTesting(sheets);
    resetMembersCache();
    as("rishii");
    const loader = vi.fn();
    const ctx = await loadForMember(loader);
    expect(loader).not.toHaveBeenCalled();
    expect(ctx.result).toMatchObject({ ok: false, title: "Account not active" });
  });

  it("turns data-layer failures into a safe message with no details, never sample data", async () => {
    as("anni");
    sheets.failAll = googleError(403, "forbidden");
    resetMembersCache();
    const ctx = await loadForMember(listJobsForMember);
    expect(ctx.result.ok).toBe(false);
    const text = JSON.stringify(ctx.result);
    expect(text).toContain("not shared with the service account");
    expect(text).not.toContain("SECRET-DETAIL");
  });

  it("contains unexpected errors with a generic message", async () => {
    as("anni");
    const ctx = await loadForMember(async () => {
      throw new Error("boom SECRET-DETAIL");
    });
    expect(ctx.result).toEqual({ ok: false, title: "Something went wrong", message: "Please try again in a moment." });
  });
});
