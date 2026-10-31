/**
 * Structured email drafting: member identity, approved skill taxonomy, 10 role templates, skill matching,
 * personalisation, and the validation every draft must pass (no fabricated skills/company facts, no other member's
 * identity, no internal ids, no placeholders, no truncation, full signature).
 */
import { describe, expect, it } from "vitest";
import { EMAIL_TEMPLATES } from "@/config/email-templates";
import { MEMBER_EMAIL_PROFILES } from "@/config/member-email-profiles";
import { MEMBERS, type MemberId } from "@/config/members";
import { SKILLS, TEMPLATE_IDS, getSkill } from "@/config/skills";
import {
  assembleEmail, buildEmailPlan, cleanParagraphs, composeFallback, jobForCompany, recipientFirstName, selectTemplate, signatureFor, subjectFor, unverifiedSkills, validateEmail, wordCount,
} from "@/lib/network-finder/email-composer";
import type { Job } from "@/types/domain";

const IDS: MemberId[] = ["anni", "lukky", "rishii"];
const plan = (memberId: MemberId, title?: string, extra: Partial<Parameters<typeof buildEmailPlan>[0]> = {}) =>
  buildEmailPlan({ memberId, company: { name: "Acme Labs" }, person: { name: "Rahul Sharma", title: "CTO" }, ...(title ? { job: { title } } : {}), ...extra });
const fallbackBody = (p: ReturnType<typeof plan>) => assembleEmail(p, composeFallback(p));

describe("member identity (central config)", () => {
  const expected = {
    anni: ["Anni", "Aniket Raj", "https://www.linkedin.com/in/raj-aniket/", "https://github.com/iamankoo"],
    lukky: ["Lukky", "Lakshya Singh", "https://www.linkedin.com/in/lakshya-singh-243510302/", "https://github.com/lukkydiwan"],
    rishii: ["Rishii", "Rishi Raj", "https://www.linkedin.com/in/rishi-raj-8bb5a8366/", "https://github.com/Rishi-Ra-1j4"],
  };
  it.each(IDS)("%s → full name + own LinkedIn + own GitHub in the signature", (id) => {
    const m = MEMBERS.find((x) => x.id === id)!;
    expect([m.name, m.fullName, m.linkedinUrl, m.githubUrl]).toEqual(expected[id]);
    const body = fallbackBody(plan(id, "Software Engineer"));
    expect(body.endsWith(`Best regards,\n${expected[id][1]}\nLinkedIn: ${expected[id][2]}\nGitHub: ${expected[id][3]}`)).toBe(true);
  });
});

describe("approved skill taxonomy and verified profiles (data integrity)", () => {
  it("exactly 200 unique skills with categories, aliases, roles and priority", () => {
    expect(SKILLS.length).toBe(200);
    expect(new Set(SKILLS.map((k) => k.id)).size).toBe(SKILLS.length);
    expect(new Set(SKILLS.map((k) => k.name.toLowerCase())).size).toBe(SKILLS.length);
    for (const k of SKILLS) for (const r of k.roles) expect(TEMPLATE_IDS).toContain(r);
  });
  it("every skill id used by profiles, highlights and templates exists; highlights only use the member's own skills", () => {
    for (const id of IDS) {
      const p = MEMBER_EMAIL_PROFILES[id];
      for (const s of p.skills) expect(getSkill(s), `${id}: ${s}`).toBeDefined();
      for (const h of p.highlights) for (const s of h.skills) expect(p.skills, `${id} highlight ${h.title}: ${s}`).toContain(s);
    }
    for (const t of EMAIL_TEMPLATES) {
      for (const s of t.prioritySkills) expect(getSkill(s), `${t.id}: ${s}`).toBeDefined();
      for (const a of t.areas) for (const s of a.skills) expect(getSkill(s), `${t.id} area: ${s}`).toBeDefined();
    }
  });
  it("10 templates, one per role id", () => {
    expect(EMAIL_TEMPLATES.map((t) => t.id).sort()).toEqual([...TEMPLATE_IDS].sort());
  });
});

describe("template selection", () => {
  it.each([
    ["Full Stack Developer", "full-stack"], ["React/Next.js Full Stack Engineer", "full-stack"], ["MERN Developer", "full-stack"],
    ["Frontend Engineer", "frontend"], ["React Developer Intern", "frontend"],
    ["Backend Engineer", "backend"], ["Node.js Developer", "backend"], ["Software Engineer - Backend", "backend"],
    ["Software Engineer", "software"], ["SDE Intern", "software"], ["Software Developer Intern", "software"],
    ["AI/ML Intern", "ai-ml"], ["Machine Learning Engineer", "ai-ml"],
    ["Data Analyst Intern", "data-analyst"], ["Business Intelligence Analyst", "data-analyst"],
    ["Data Engineer", "data-engineer"], ["ETL Developer", "data-engineer"],
    ["LLM Engineer", "llm"], ["Generative AI Intern", "llm"], ["AI Engineer", "llm"],
    ["Python Developer", "automation"], ["Automation Engineer", "automation"],
    ["Flutter Developer", "mobile"], ["Android Developer", "mobile"],
  ] as const)("%s → %s", (title, id) => {
    expect(selectTemplate(title)).toBe(id);
  });
  it("ambiguous titles use Software Engineer; a clear description can decide", () => {
    expect(selectTemplate("Founding Engineer")).toBe("software");
    expect(selectTemplate(undefined)).toBe("software");
    expect(selectTemplate("Engineer", "You will build RAG pipelines on LLMs and design agentic workflows with LangChain.")).toBe("llm");
  });
});

describe("personalisation", () => {
  it("greets a real first name, otherwise the hiring team", () => {
    expect(recipientFirstName("Rahul Sharma")).toBe("Rahul");
    expect(recipientFirstName("priya")).toBe("Priya");
    expect(recipientFirstName("Hiring Team")).toBeNull();
    expect(recipientFirstName("HR")).toBeNull();
    expect(recipientFirstName("")).toBeNull();
    expect(plan("anni").greeting).toBe("Dear Rahul,");
    expect(plan("anni", undefined, { person: { name: "Talent Acquisition" } }).greeting).toBe("Dear Hiring Team,");
  });

  it("role-specific subjects; internships are explicit; no job → the role family", () => {
    expect(plan("anni", "Data Analyst Intern").subject).toBe("Application for Data Analyst Internship — Acme Labs");
    expect(plan("anni", "Backend Engineer").subject).toBe("Application for Backend Engineer — Acme Labs");
    expect(plan("anni", "Machine Learning", { job: { title: "Machine Learning", internship: true } }).subject).toBe("Application for Machine Learning Internship — Acme Labs");
    expect(plan("anni").subject).toBe("Application for Software Engineer opportunities — Acme Labs");
    expect(subjectFor({ jobTitle: "Flutter Developer", roleLabel: "x", internship: false, company: "Zed" })).toBe("Application for Flutter Developer — Zed");
  });

  it("picks 4–8 relevant skills from the member's OWN profile for each role (examples from the brief)", () => {
    expect(plan("anni", "React/Next.js Full Stack Engineer").skills).toEqual(["React", "Next.js", "TypeScript", "Node.js", "Express.js", "REST APIs", "MongoDB", "PostgreSQL"]);
    expect(plan("anni", "AI/ML Intern").skills).toEqual(expect.arrayContaining(["Python", "OpenAI API", "Gemini API", "Retrieval-Augmented Generation (RAG)"]));
    expect(plan("anni", "Data Analyst Intern").skills).toEqual(expect.arrayContaining(["Python", "SQL"]));
    expect(plan("anni", "Backend Engineer").skills).toEqual(expect.arrayContaining(["Node.js", "Express.js", "FastAPI", "REST APIs", "Redis"]));
    for (const id of IDS) for (const t of TEMPLATE_IDS) expect(plan(id, EMAIL_TEMPLATES.find((x) => x.id === t)!.roleLabel).skills.length).toBeLessThanOrEqual(8);
    expect(plan("anni", "Software Engineer").skills.length).toBeGreaterThanOrEqual(4);
  });

  it("job-description skills the member has are preferred and named as the role's focus", () => {
    const p = plan("anni", "Software Engineer", { job: { title: "Software Engineer", description: "Our stack is Redis, PostgreSQL and Docker." } });
    expect(p.skillsInJob).toEqual(expect.arrayContaining(["Redis", "PostgreSQL"]));
    expect(fallbackBody(p)).toMatch(/Software Engineer role's emphasis on (Redis|PostgreSQL|Docker)/);
  });

  it("chooses 1–2 genuinely relevant highlights for the role", () => {
    expect(plan("anni", "LLM Engineer").highlights.map((h) => h.title)).toContain("AI Intern (Backend & APIs) at Codec Technologies");
    expect(plan("anni", "Flutter Developer").highlights[0].title).toBe("App Developer Intern at Ramyoz Solutions");
    expect(plan("anni", "Full Stack Developer").highlights.length).toBeLessThanOrEqual(2);
  });

  it("the email names the recipient, company, exact role, skills, a project and the member", () => {
    const p = plan("lukky", "Full Stack Developer Intern", { company: { name: "Learnosphere" }, person: { name: "Asha Verma" } });
    const body = fallbackBody(p);
    expect(body.startsWith("Dear Asha,")).toBe(true);
    expect(body).toContain("the Full Stack Developer Intern at Learnosphere");
    expect(body).toMatch(/React.*Node\.js|Node\.js.*React/);
    expect(body).toContain("MERN stack");
    expect(body).toContain("Lakshya Singh");
  });

  it("uses verified company context only when given; otherwise a neutral sentence (no invented facts)", () => {
    const p = plan("anni", "Software Engineer", { company: { name: "Acme Labs", description: "Acme Labs builds scheduling tools for clinics." } });
    expect(p.companyContext).toBe("Acme Labs builds scheduling tools for clinics.");
    expect(fallbackBody(plan("anni", "Software Engineer"))).toContain("What particularly interests me about Acme Labs is the opportunity to grow");
  });

  it("finds the company's best open job in Jobs (name variants, relevant + newest first)", () => {
    const job = (role: string, company: string, addedAt: string, type: Job["jobType"] = "Full-time"): Job => ({ jobId: `job_${role}`, company, jobRole: role, jobType: type, location: "Remote", jobUrl: "https://x.example", addedBy: "anni", addedAt });
    const jobs = [job("Account Executive", "Acme Labs Inc.", "2026-10-27T10:00:00Z"), job("Backend Engineer", "ACME LABS", "2026-10-20T10:00:00Z"), job("Data Analyst Intern", "Acme Labs", "2026-10-25T10:00:00Z", "Internship"), job("Frontend Engineer", "Other Co", "2026-10-27T11:00:00Z")];
    expect(jobForCompany(jobs, "Acme Labs")).toMatchObject({ title: "Data Analyst Intern", internship: true });
    expect(jobForCompany(jobs, "Nobody")).toBeUndefined();
  });
});

describe("safety and validation", () => {
  it("every member × every role: the template fill passes validation (no fabricated skills, ends cleanly, right identity)", () => {
    for (const id of IDS) {
      for (const t of EMAIL_TEMPLATES) {
        for (const title of [t.roleLabel, `${t.roleLabel} Intern`, undefined]) {
          const p = plan(id, title, { job: title ? { title, description: "We use React, Node.js, Kubernetes, Golang and Snowflake.", workMode: "Remote" } : undefined });
          const body = fallbackBody(p);
          expect(validateEmail(body, p), `${id} / ${title}`).toEqual([]);
          expect(wordCount(body)).toBeLessThanOrEqual(340); // 300 body words + signature
        }
      }
    }
  });

  it("Rishi (no verified profile yet) is never given any skill claims", () => {
    const p = plan("rishii", "Full Stack Developer");
    expect(p.skills).toEqual([]);
    expect(p.highlights).toEqual([]);
    expect(unverifiedSkills(fallbackBody(p), "rishii", [p.jobTitle ?? "", p.roleLabel, p.company])).toEqual([]);
  });

  it("rejects: unverified skills, other members, internal ids, placeholders, truncation, banned phrases, invented company facts, missing signature, too long/short", () => {
    const p = plan("lukky", "Backend Engineer");
    const ok = fallbackBody(p);
    expect(validateEmail(ok, p)).toEqual([]);
    const swap = (from: string, to: string) => validateEmail(ok.replace(from, to), p);
    const firstPara = composeFallback(p)[0];
    expect(swap(firstPara, `${firstPara} I also know Docker and PostgreSQL well.`)).toEqual(expect.arrayContaining(["unverified skill: Docker", "unverified skill: PostgreSQL"]));
    expect(validateEmail(ok.replace(firstPara, `${firstPara} Aniket Raj recommended me.`), p)).toContain("another member's identity (anni)");
    expect(validateEmail(ok.replace(firstPara, `${firstPara} https://github.com/iamankoo`), p)).toContain("another member's identity (anni)");
    expect(validateEmail(ok.replace(firstPara, `${firstPara} Lukky here.`), p)).toContain("internal member id in text");
    expect(validateEmail(ok.replace(firstPara, `${firstPara} {{company_name}}`), p)).toContain("unresolved placeholder");
    expect(validateEmail(ok.replace(firstPara, `${firstPara} And I…`), p)).toContain("ellipsis / truncation");
    expect(validateEmail(ok.replace(firstPara, `${firstPara} I believe I am the perfect fit.`), p)).toContain("banned phrase: perfect fit");
    expect(validateEmail(ok.replace(firstPara, `${firstPara} Congratulations on raising $10 million.`), p)).toContain("unverified company claim");
    expect(validateEmail(ok.replace(signatureFor(p), "Best regards,\nLakshya Singh"), p)).toContain("signature missing or not last");
    expect(validateEmail(ok.replace(firstPara, `${firstPara} ${"More words here. ".repeat(60)}`), p)).toContain(`too long (${wordCount(ok.replace(firstPara, `${firstPara} ${"More words here. ".repeat(60)}`).slice(0, -signatureFor(p).length).replace(p.greeting, ""))} words)`);
    expect(validateEmail(assembleEmail(p, ["Short note."]), p).some((x) => x.startsWith("too short"))).toBe(true);
  });

  it("a cut-off last paragraph is caught", () => {
    const p = plan("anni", "Backend Engineer");
    const paras = composeFallback(p);
    const cut = `${p.greeting}\n\n${[...paras.slice(0, -1), "I would be glad to share my resume and to discuss how my"].join("\n\n")}\n\n${signatureFor(p)}`;
    expect(validateEmail(cut, p)).toContain("does not end cleanly");
  });

  it("strips a writer's greeting and sign-off so the signature appears exactly once", () => {
    expect(cleanParagraphs(["Dear Rahul,", "Body one.", "Body two.", "Best regards,\nLakshya Singh"], "Lakshya Singh")).toEqual(["Body one.", "Body two."]);
    expect(cleanParagraphs(["Body.", "Thanks!\nLakshya Singh\nLinkedIn: x"], "Lakshya Singh")).toEqual(["Body."]);
  });
});
