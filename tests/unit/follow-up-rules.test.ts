import { describe, expect, it } from "vitest";
import { evaluateFollowUp, FOLLOW_UP_AFTER_HOURS, FOLLOW_UP_AFTER_SECONDS, followUpDueAt } from "@/lib/follow-ups/rules";
import { applyFollowUpAnswer, progressCategory, progressLevel } from "@/lib/follow-ups/progress";
import type { Application } from "@/types/domain";

const APPLIED_AT = "2026-10-01T10:00:00.000Z";
const job = { addedAt: "2026-10-01T09:00:00.000Z" };
const app = (over: Partial<Application> = {}): Application => ({
  jobId: "job_1", memberId: "anni", status: "Applied", appliedAt: APPLIED_AT, lastUpdated: APPLIED_AT, ...over,
});
const at = (iso: string) => new Date(iso);

describe("168-hour timer", () => {
  it("is exactly 7 x 24 hours = 604,800 seconds", () => {
    expect(FOLLOW_UP_AFTER_HOURS).toBe(168);
    expect(FOLLOW_UP_AFTER_SECONDS).toBe(604_800);
    expect(followUpDueAt(APPLIED_AT)?.toISOString()).toBe("2026-10-08T10:00:00.000Z");
  });

  it("is not due one millisecond before 168 hours", () => {
    const v = evaluateFollowUp(app(), job, at("2026-10-08T09:59:59.999Z"));
    expect(v).toEqual({ state: "not_due", dueAt: "2026-10-08T10:00:00.000Z" });
  });

  it("is due at exactly 168 hours", () => {
    expect(evaluateFollowUp(app(), job, at("2026-10-08T10:00:00.000Z"))).toEqual({ state: "due", dueAt: "2026-10-08T10:00:00.000Z" });
  });

  it("stays due after 168 hours (including much later)", () => {
    expect(evaluateFollowUp(app(), job, at("2026-10-08T10:00:00.001Z")).state).toBe("due");
    expect(evaluateFollowUp(app(), job, at("2026-10-20T00:00:00.000Z")).state).toBe("due");
  });

  it("is computed on UTC instants, so time zones and date boundaries do not matter", () => {
    // applied 23:30 UTC on Oct 1 (= 05:00 on Oct 2 in IST): still due exactly 168 h later in UTC
    const late = app({ appliedAt: "2026-10-01T23:30:00.000Z" });
    expect(evaluateFollowUp(late, job, at("2026-10-08T23:29:59.999Z")).state).toBe("not_due");
    expect(evaluateFollowUp(late, job, at("2026-10-08T23:30:00.000Z")).state).toBe("due");
    // across a month boundary and a leap day
    expect(followUpDueAt("2028-02-25T12:00:00.000Z")?.toISOString()).toBe("2028-03-03T12:00:00.000Z");
    expect(followUpDueAt("2026-10-28T12:00:00.000Z")?.toISOString()).toBe("2026-11-04T12:00:00.000Z");
    // an instant written with an offset-free Z is the only accepted form
    expect(followUpDueAt("2026-10-01T10:00:00+05:30")).toBeNull();
  });

  it("missing or invalid AppliedAt is reported as invalid and never shown", () => {
    expect(evaluateFollowUp(app({ appliedAt: undefined }), job, at("2026-10-09T00:00:00Z"))).toEqual({ state: "invalid", reason: "missing_applied_at" });
    for (const bad of ["yesterday", "2026-13-45T00:00:00Z", "2026-10-01", "2026-10-01 10:00"]) {
      expect(evaluateFollowUp(app({ appliedAt: bad }), job, at("2026-10-09T00:00:00Z"))).toEqual({ state: "invalid", reason: "invalid_applied_at" });
    }
  });

  it("is deterministic across repeated evaluations (visits, refreshes, restarts)", () => {
    const now = at("2026-10-09T00:00:00.000Z");
    const first = evaluateFollowUp(app(), job, now);
    for (let i = 0; i < 5; i++) expect(evaluateFollowUp(app(), job, now)).toEqual(first);
  });
});

describe("who is asked", () => {
  const due = at("2026-10-09T00:00:00.000Z");

  it("suppresses Not Applied and unknown/finished statuses", () => {
    expect(evaluateFollowUp(app({ status: "Not Applied", appliedAt: undefined }), job, due)).toEqual({ state: "suppressed", reason: "not_applied" });
    for (const status of ["Interview", "Offer", "Rejected"] as const) {
      expect(evaluateFollowUp(app({ status }), job, due)).toEqual({ state: "suppressed", reason: "status" });
    }
  });

  it("asks Applied and In Progress applications", () => {
    expect(evaluateFollowUp(app({ status: "Applied" }), job, due).state).toBe("due");
    expect(evaluateFollowUp(app({ status: "In Progress" }), job, due).state).toBe("due");
  });

  it("never re-asks an answered follow-up", () => {
    for (const answer of ["Shortlisted", "Interview", "Offer", "No update"] as const) {
      expect(evaluateFollowUp(app({ followUpAnswer: answer, followUpAnsweredAt: "2026-10-09T00:00:00.000Z" }), job, due)).toEqual({ state: "suppressed", reason: "answered" });
    }
  });

  it("suppresses applications already at Interview or Offer stages, but still asks a merely Shortlisted one", () => {
    for (const stage of ["Technical Interview", "HR Interview", "Final Round", "Offer", "Closed"] as const) {
      expect(evaluateFollowUp(app({ applicationStage: stage }), job, due), stage).toEqual({ state: "suppressed", reason: "stage" });
    }
    for (const stage of ["Submitted", "Shortlisted", "Online Assessment", "Screening"] as const) {
      expect(evaluateFollowUp(app({ applicationStage: stage }), job, due).state, stage).toBe("due");
    }
  });

  it("suppresses a missing job and an expired job (30 days after AddedAt), so a follow-up cannot extend a job's life", () => {
    expect(evaluateFollowUp(app(), undefined, due)).toEqual({ state: "suppressed", reason: "job_missing" });
    // job added Sep 1; on Oct 1 10:00 it is 30 days + 1 h old
    expect(evaluateFollowUp(app({ appliedAt: "2026-09-20T10:00:00.000Z" }), { addedAt: "2026-09-01T09:00:00.000Z" }, at("2026-10-01T10:00:00.000Z"))).toEqual({
      state: "suppressed", reason: "job_expired",
    });
    // not yet expired on day 29
    expect(evaluateFollowUp(app({ appliedAt: "2026-09-02T00:00:00.000Z" }), { addedAt: "2026-09-01T09:00:00.000Z" }, at("2026-09-30T00:00:00.000Z")).state).toBe("due");
  });
});

describe("progress levels and answer application (never downgrades)", () => {
  it("derives one pipeline position from status and stage", () => {
    expect(progressLevel({ status: "Applied" })).toBe(0);
    expect(progressLevel({ status: "In Progress" })).toBe(0);
    expect(progressLevel({ status: "Applied", applicationStage: "Shortlisted" })).toBe(1);
    expect(progressLevel({ status: "Interview" })).toBe(2);
    expect(progressLevel({ status: "Applied", applicationStage: "HR Interview" })).toBe(2);
    expect(progressLevel({ status: "Offer" })).toBe(3);
    expect(progressLevel({ status: "Applied", applicationStage: "Offer" })).toBe(3);
    expect(progressLevel({ status: "Rejected" })).toBe(0);
    // stages that are not progress never inflate a category
    for (const stage of ["Submitted", "Online Assessment", "Screening", "Closed"] as const) expect(progressLevel({ status: "Applied", applicationStage: stage })).toBe(0);
    expect(progressCategory({ status: "Applied" })).toBeNull();
    expect(progressCategory({ status: "Interview" })).toBe("interview");
  });

  it("Shortlisted sets the stage; Interview sets the status; Offer sets status and stage; No update changes nothing", () => {
    const base = { status: "Applied" as const, applicationStage: undefined };
    expect(applyFollowUpAnswer(base, "Shortlisted")).toMatchObject({ status: "Applied", applicationStage: "Shortlisted" });
    expect(applyFollowUpAnswer(base, "Interview")).toMatchObject({ status: "Interview" });
    expect(applyFollowUpAnswer(base, "Offer")).toMatchObject({ status: "Offer", applicationStage: "Offer" });
    expect(applyFollowUpAnswer(base, "No update")).toBe(base);
  });

  it("never moves an application to an earlier position", () => {
    const atOffer = { status: "Offer" as const, applicationStage: "Offer" as const };
    for (const a of ["Shortlisted", "Interview", "Offer", "No update"] as const) expect(applyFollowUpAnswer(atOffer, a)).toBe(atOffer);
    const atInterview = { status: "Interview" as const, applicationStage: undefined };
    expect(applyFollowUpAnswer(atInterview, "Shortlisted")).toBe(atInterview);
    expect(applyFollowUpAnswer(atInterview, "Interview")).toBe(atInterview);
    expect(applyFollowUpAnswer(atInterview, "Offer")).toMatchObject({ status: "Offer", applicationStage: "Offer" });
    const shortlisted = { status: "Applied" as const, applicationStage: "Shortlisted" as const };
    expect(applyFollowUpAnswer(shortlisted, "Shortlisted")).toBe(shortlisted);
    expect(applyFollowUpAnswer(shortlisted, "Interview")).toMatchObject({ status: "Interview", applicationStage: "Shortlisted" });
  });
});
