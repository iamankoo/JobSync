import { describe, expect, it } from "vitest";
import { extractRole, roleForConnection } from "@/lib/network-finder/connection-role";
import { selectTemplate } from "@/lib/network-finder/email-composer";

const found = (text: string) => {
  const r = extractRole(text);
  if (r.status !== "found") throw new Error(`expected a role in "${text}", got ${r.status}`);
  return r.role;
};

describe("reading the role from a connection's description", () => {
  it("reads the 'Role: …' form the members write", () => {
    expect(found("Role: Ai Applied Engineer")).toEqual({ title: "AI Applied Engineer", internship: false });
    expect(selectTemplate("AI Applied Engineer")).toBe("llm");
  });

  it("takes ANY role written after a label, not only engineer-style titles", () => {
    expect(found("Role: DevOps")).toMatchObject({ title: "DevOps" });
    expect(found("Position: SDE-1 (Remote)")).toMatchObject({ title: "SDE-1" });
    expect(found("Job title: product designer - Growth")).toEqual({ title: "Product Designer", focus: "Growth", internship: false });
    expect(found("Role: Quantitative Research Intern")).toMatchObject({ internship: true });
    expect(extractRole("Role: Backend Engineer or Data Engineer").status).toBe("ambiguous");
  });

  it("Magic Hour AI: Machine Learning Engineer with a Video Generation focus", () => {
    const r = found("Hiring for Machine Learning Engineer – Video Generation.");
    expect(r).toEqual({ title: "Machine Learning Engineer", focus: "Video Generation", internship: false });
    expect(selectTemplate(r.title)).toBe("ai-ml");
  });

  it("Learnosphere: Full Stack Developer Intern", () => {
    const r = found("Looking for a Full Stack Developer Intern for the summer.");
    expect(r).toMatchObject({ title: "Full Stack Developer Intern", internship: true });
    expect(selectTemplate(r.title)).toBe("full-stack");
  });

  it("Alehar: Technology, Data & AI Internship", () => {
    const r = found("Technology, Data & AI Internship");
    expect(r).toMatchObject({ title: "Technology, Data & AI Internship", internship: true });
    expect(selectTemplate(r.title)).toBe("ai-ml");
  });

  it("backend and data engineering roles, and a parenthesised focus", () => {
    expect(found("Hiring a backend engineer (Payments).")).toEqual({ title: "Backend Engineer", focus: "Payments", internship: false });
    const d = found("role: data engineer");
    expect(d.title).toBe("Data Engineer");
    expect(selectTemplate(d.title)).toBe("data-engineer");
  });

  it("does not assume a role when there is none, and flags two different roles", () => {
    expect(extractRole("Met at the campus fair, very friendly").status).toBe("missing");
    expect(extractRole("He is the Engineering Manager there").status).toBe("missing");
    expect(extractRole("").status).toBe("missing");
    expect(extractRole("Hiring for ML Engineer and Backend Engineer roles").status).toBe("ambiguous");
  });

  it("uses the notes first, then the suggested message, never the person's designation", () => {
    expect(roleForConnection({ notes: "Role: Data Analyst", message: "Hi, I am interested in the Backend Engineer role" })).toMatchObject({ status: "found", role: { title: "Data Analyst" } });
    expect(roleForConnection({ notes: "met at a meetup", message: "Hi, I am interested in the Backend Engineer role" })).toMatchObject({ status: "found", role: { title: "Backend Engineer" } });
  });
});
