import { describe, expect, it } from "vitest";
import { createJobSchema } from "@/lib/validation/jobs";
import { ALLOWED_TRANSITIONS, canTransition, jobIdSchema, updateApplicationSchema } from "@/lib/validation/applications";
import { APPLICATION_STATUSES } from "@/types/domain";

const validJob = {
  company: "Synthetic Co A",
  jobRole: "Test Role",
  jobType: "Full-time",
  location: "Testville",
  jobUrl: "https://jobs.example.test/jobs/1",
};

describe("createJobSchema", () => {
  it("accepts a minimal valid job and trims text", () => {
    const r = createJobSchema.parse({ ...validJob, company: "  Synthetic Co A  " });
    expect(r.company).toBe("Synthetic Co A");
    expect(r.deadline).toBeUndefined();
  });

  it("accepts all optional fields and treats empty strings as absent", () => {
    const r = createJobSchema.parse({
      ...validJob, workMode: "Hybrid", experience: "0-2 years", stipendSalary: "₹50k/month",
      deadline: "2026-11-01", description: "Great role",
    });
    expect(r.workMode).toBe("Hybrid");
    const empty = createJobSchema.parse({ ...validJob, workMode: "", experience: "  ", deadline: "", description: "" });
    expect(empty.workMode).toBeUndefined();
    expect(empty.experience).toBeUndefined();
    expect(empty.deadline).toBeUndefined();
  });

  it("rejects missing required fields", () => {
    for (const key of ["company", "jobRole", "jobType", "location", "jobUrl"] as const) {
      const { [key]: _omit, ...rest } = validJob;
      void _omit;
      expect(createJobSchema.safeParse(rest).success, key).toBe(false);
    }
    expect(createJobSchema.safeParse({ ...validJob, company: "   " }).success).toBe(false);
  });

  it("rejects bad URLs, enums, dates and oversized text", () => {
    expect(createJobSchema.safeParse({ ...validJob, jobUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(createJobSchema.safeParse({ ...validJob, jobUrl: "nope" }).success).toBe(false);
    expect(createJobSchema.safeParse({ ...validJob, jobType: "Volunteer" }).success).toBe(false);
    expect(createJobSchema.safeParse({ ...validJob, workMode: "Onsite" }).success).toBe(false);
    expect(createJobSchema.safeParse({ ...validJob, deadline: "2026-02-30" }).success).toBe(false);
    expect(createJobSchema.safeParse({ ...validJob, deadline: "01/11/2026" }).success).toBe(false);
    expect(createJobSchema.safeParse({ ...validJob, company: "x".repeat(121) }).success).toBe(false);
    expect(createJobSchema.safeParse({ ...validJob, description: "x".repeat(5001) }).success).toBe(false);
    expect(createJobSchema.safeParse({ ...validJob, company: "bad\u0000name" }).success).toBe(false);
  });

  it("rejects client-supplied identity or server-controlled fields", () => {
    expect(createJobSchema.safeParse({ ...validJob, addedBy: "lukky" }).success).toBe(false);
    expect(createJobSchema.safeParse({ ...validJob, jobId: "job_x" }).success).toBe(false);
    expect(createJobSchema.safeParse({ ...validJob, addedAt: "2020-01-01T00:00:00Z" }).success).toBe(false);
  });
});

describe("updateApplicationSchema", () => {
  it("accepts a status with optional stage and notes", () => {
    expect(updateApplicationSchema.parse({ status: "Applied" }).status).toBe("Applied");
    const r = updateApplicationSchema.parse({ status: "Interview", applicationStage: "Technical Interview", notes: " good " });
    expect(r.notes).toBe("good");
    expect(updateApplicationSchema.parse({ status: "Applied", applicationStage: null, notes: null }).notes).toBeNull();
  });

  it("rejects unknown statuses/stages, long notes and any memberId", () => {
    expect(updateApplicationSchema.safeParse({ status: "Hired" }).success).toBe(false);
    expect(updateApplicationSchema.safeParse({ status: "Applied", applicationStage: "Lunch" }).success).toBe(false);
    expect(updateApplicationSchema.safeParse({ status: "Applied", notes: "x".repeat(1001) }).success).toBe(false);
    expect(updateApplicationSchema.safeParse({ status: "Applied", memberId: "lukky" }).success).toBe(false);
    expect(updateApplicationSchema.safeParse({}).success).toBe(false);
  });

  it("validates job IDs", () => {
    expect(jobIdSchema.safeParse("job_3f2b-aa").success).toBe(true);
    expect(jobIdSchema.safeParse("../etc/passwd").success).toBe(false);
    expect(jobIdSchema.safeParse("a b").success).toBe(false);
    expect(jobIdSchema.safeParse("x".repeat(65)).success).toBe(false);
  });
});

describe("status transitions", () => {
  it("allows applying from Not Applied, but nothing else", () => {
    expect(canTransition("Not Applied", "Applied")).toBe(true);
    for (const s of APPLICATION_STATUSES.filter((x) => x !== "Applied" && x !== "Not Applied")) {
      expect(canTransition("Not Applied", s), s).toBe(false);
    }
  });

  it("allows same-status updates and the documented moves", () => {
    for (const s of APPLICATION_STATUSES) expect(canTransition(s, s)).toBe(true);
    expect(canTransition("Applied", "Not Applied")).toBe(true);
    expect(canTransition("Applied", "Interview")).toBe(true);
    expect(canTransition("Interview", "Offer")).toBe(true);
    expect(canTransition("Offer", "Applied")).toBe(false);
    expect(canTransition("Rejected", "Applied")).toBe(false);
    expect(canTransition("Rejected", "In Progress")).toBe(true);
  });

  it("defines targets only for known statuses", () => {
    for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
      expect(APPLICATION_STATUSES).toContain(from);
      for (const t of targets) expect(APPLICATION_STATUSES).toContain(t);
    }
  });
});
