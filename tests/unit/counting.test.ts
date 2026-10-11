import { describe, expect, it } from "vitest";
import { countApplications, EMPTY_COUNTS, isPending, notAppliedCount, type CountableApplication } from "@/lib/counting";

const a = (jobId: string, status: CountableApplication["status"], applicationStage?: CountableApplication["applicationStage"]): CountableApplication => ({ jobId, status, applicationStage });

describe("counting rules (single source of truth)", () => {
  it("empty data gives honest zeros", () => {
    expect(countApplications([])).toEqual(EMPTY_COUNTS);
    expect(notAppliedCount(0, 0)).toBe(0);
  });

  it("Not Applied is never an application", () => {
    expect(countApplications([a("1", "Not Applied"), a("2", "Not Applied", "Shortlisted")])).toEqual(EMPTY_COUNTS);
  });

  it("applied includes pending: Pending is a subset, never added on top", () => {
    const c = countApplications([a("1", "Applied"), a("2", "In Progress"), a("3", "Interview"), a("4", "Offer"), a("5", "Rejected")]);
    expect(c.applied).toBe(5);
    expect(c.pending).toBe(3); // Applied + In Progress + Interview: no known outcome
    expect(c.pending).toBeLessThanOrEqual(c.applied);
    expect(c.applied).not.toBe(c.applied + c.pending);
  });

  it("pending = applied with no known outcome (not Rejected, not at Offer)", () => {
    expect(isPending({ status: "Applied" })).toBe(true);
    expect(isPending({ status: "In Progress" })).toBe(true);
    expect(isPending({ status: "Interview" })).toBe(true);
    expect(isPending({ status: "Applied", applicationStage: "Shortlisted" })).toBe(true);
    expect(isPending({ status: "Offer" })).toBe(false);
    expect(isPending({ status: "Applied", applicationStage: "Offer" })).toBe(false);
    expect(isPending({ status: "Rejected" })).toBe(false);
    expect(isPending({ status: "Not Applied" })).toBe(false);
  });

  it("shortlisted / interviewed / offers come from the persisted status+stage, each application in one category only", () => {
    const c = countApplications([
      a("1", "Applied", "Shortlisted"), a("2", "In Progress", "Shortlisted"),
      a("3", "Interview"), a("4", "Applied", "Technical Interview"), a("5", "Applied", "HR Interview"), a("6", "Applied", "Final Round"),
      a("7", "Offer"), a("8", "Applied", "Offer"),
      a("9", "Applied"), // nothing beyond applied
    ]);
    expect(c).toMatchObject({ applied: 9, shortlisted: 2, interviewed: 4, offers: 2 });
    expect(c.shortlisted + c.interviewed + c.offers).toBeLessThanOrEqual(c.applied);
  });

  it("a stage change moves an application between categories instead of counting it twice", () => {
    const shortlisted = countApplications([a("1", "Applied", "Shortlisted")]);
    const interviewed = countApplications([a("1", "Interview", "Shortlisted")]); // shortlisted earlier, now at interview
    const offered = countApplications([a("1", "Offer", "Offer")]);
    expect([shortlisted.shortlisted, shortlisted.interviewed, shortlisted.offers]).toEqual([1, 0, 0]);
    expect([interviewed.shortlisted, interviewed.interviewed, interviewed.offers]).toEqual([0, 1, 0]);
    expect([offered.shortlisted, offered.interviewed, offered.offers]).toEqual([0, 0, 1]);
    for (const c of [shortlisted, interviewed, offered]) expect(c.applied).toBe(1);
  });

  it("rejected counts the Rejected status; unknown/missing stages never inflate any category", () => {
    const c = countApplications([a("1", "Rejected"), a("2", "Applied", "Submitted"), a("3", "Applied", "Closed"), a("4", "Applied", "Screening")]);
    expect(c).toMatchObject({ applied: 4, rejected: 1, shortlisted: 0, interviewed: 0, offers: 0 });
  });

  it("inProgress counts the In Progress status only", () => {
    expect(countApplications([a("1", "In Progress"), a("2", "Applied"), a("3", "In Progress")]).inProgress).toBe(2);
  });

  it("duplicate records for the same job count once", () => {
    const c = countApplications([a("1", "Applied", "Shortlisted"), a("1", "Applied", "Shortlisted"), a("1", "Interview")]);
    expect(c.applied).toBe(1);
    expect(c.shortlisted).toBe(1);
    expect(c.interviewed).toBe(0); // first record wins; the duplicate is ignored
  });

  it("not applied = shared jobs minus applied, never negative", () => {
    expect(notAppliedCount(10, 4)).toBe(6);
    expect(notAppliedCount(3, 5)).toBe(0);
  });
});
