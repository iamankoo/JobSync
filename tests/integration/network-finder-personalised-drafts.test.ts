/**
 * Company- and job-specific drafting. Templates are only the STRUCTURE: each draft is built from
 * member profile + company + the company's real opening + its description + the company's own words.
 * A fake public web stands in for the company sites and boards; the mailboxes are mocks (nothing is sent).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEMBERS, type MemberId } from "@/config/members";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { createJob } from "@/lib/google-sheets/jobs-service";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { createCompanyResearcher, isPublicHostname, pageNamesCompany, websiteCandidates } from "@/lib/network-finder/company-research";
import { loadNetworkFinderConfig } from "@/lib/network-finder/config";
import { buildEmailPlan, composeFallback, assembleEmail, validateEmail } from "@/lib/network-finder/email-composer";
import { existingJobs } from "@/lib/network-finder/gateways";
import { draftForContact, type DraftTarget } from "@/lib/network-finder/pipeline";
import { createCompanyBoardSource } from "@/lib/network-finder/providers/job-boards";
import { FakeSheets } from "../helpers/fake-sheets";
import { MockMailboxes, mockWeb, testFetcher } from "../helpers/network-finder-mocks";

let sheets: FakeSheets;
beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
});
afterEach(() => setSheetsClientForTesting(null));

const config = loadNetworkFinderConfig({ NETWORK_FINDER_ENABLED: "true" } as unknown as NodeJS.ProcessEnv);
const json = (body: unknown) => ({ type: "application/json", body: JSON.stringify(body) });

// ---- the fake public web: Magic Hour AI (Ashby board) and two other companies ---------------------------------------

const MAGIC_HOUR = {
  "https://magichour.ai/": `<html><head><title>Magic Hour</title><meta name="description" content="Magic Hour is an AI video platform that turns text and images into polished videos."></head><body><h1>Magic Hour</h1><a href="/careers">Careers</a></body></html>`,
  "https://magichour.ai/careers": `<html><body><a href="https://jobs.ashbyhq.com/magichour">Open roles</a></body></html>`,
  "https://api.ashbyhq.com/posting-api/job-board/magichour?includeCompensation=true": json({
    jobs: [
      { id: "j1", title: "Machine Learning Engineer, Video Generation", location: "Remote", isRemote: true, employmentType: "FullTime", jobUrl: "https://jobs.ashbyhq.com/magichour/j1", descriptionPlain: "Train and serve diffusion models. You will use Python, LLM tooling and embeddings to power video generation." },
      { id: "j2", title: "Frontend Engineer", location: "Remote", isRemote: true, employmentType: "FullTime", jobUrl: "https://jobs.ashbyhq.com/magichour/j2", descriptionPlain: "Build the editor in React, Next.js and TypeScript with Tailwind." },
      { id: "j3", title: "Account Executive", location: "Remote", isRemote: true, employmentType: "FullTime", jobUrl: "https://jobs.ashbyhq.com/magichour/j3", descriptionPlain: "Own the sales cycle." },
    ],
  }),
};

function researcher(routes: Record<string, string | { type?: string; body?: string }>) {
  const web = mockWeb(routes);
  const fetcher = testFetcher(web.fetchFn);
  return { research: createCompanyResearcher(fetcher, createCompanyBoardSource(fetcher)), web };
}

function run(research: ReturnType<typeof researcher>["research"] | undefined, mail: MockMailboxes, target: Partial<DraftTarget> & { company: DraftTarget["company"] }) {
  return draftForContact(
    { config, drafts: mail, jobs: existingJobs, ...(research ? { research } : {}) },
    { connectionId: "c1", name: "Jane Doe", title: "Head of Engineering", ...target },
  );
}

describe("a manually added connection at Magic Hour AI: the company and its real roles drive the draft", () => {
  it("reads the company's own site and Ashby board, and each member is pointed at the opening that fits their skills", async () => {
    const { research, web } = researcher(MAGIC_HOUR);
    const mail = new MockMailboxes();
    const outcomes = await run(research, mail, { email: "jane@magichour.ai", company: { name: "Magic Hour AI" } });
    expect(outcomes.map((o) => o.result)).toEqual(["created", "created", "created"]);
    expect(web.requests.some((r) => r.url.startsWith("https://api.ashbyhq.com/"))).toBe(true);

    const anni = mail.of("anni")[0];
    const lukky = mail.of("lukky")[0];
    const rishii = mail.of("rishii")[0];
    const titles = ["Machine Learning Engineer, Video Generation", "Frontend Engineer"];
    // every member's subject names a REAL opening at the company, never the generic default
    for (const d of [anni, lukky, rishii]) {
      expect(titles.some((t) => d.subject.includes(t.split(",")[0])), d.subject).toBe(true);
      expect(d.subject).toMatch(/— Magic Hour AI$/);
      expect(d.subject).not.toMatch(/Software Engineer/);
      expect(d.body).not.toMatch(/Software Engineer/);
      expect(d.body).toContain("Magic Hour AI");
      // the company's OWN description is used, verbatim and attributed
      expect(d.body).toContain("Magic Hour is an AI video platform that turns text and images into polished videos");
      expect(d.body).not.toMatch(/Account Executive/);
    }
    // Lukky (Python, LLM integration, RAG) is pointed at the ML role; Anni (React, Next.js, TypeScript) at either, never at sales
    expect(lukky.subject).toContain("Machine Learning Engineer");
    expect(lukky.body).toMatch(/LLM|Python/);
    // Rishii has no verified skills: a real role, but no skill or project claims
    expect(rishii.body).not.toMatch(/React|Node\.js|Python|MongoDB|TypeScript|LLM/);
  });

  it("only claims skills the member has verified, even when the job asks for more", async () => {
    const { research } = researcher(MAGIC_HOUR);
    const mail = new MockMailboxes();
    await run(research, mail, { email: "jane@magichour.ai", company: { name: "Magic Hour AI" } });
    const lukky = mail.of("lukky")[0].body;
    expect(lukky).not.toMatch(/Next\.js|TypeScript|Tailwind|PyTorch|diffusion/i);
  });

  it("drafts carry the sender's own name and links, and never another member's", async () => {
    const { research } = researcher(MAGIC_HOUR);
    const mail = new MockMailboxes();
    await run(research, mail, { email: "jane@magichour.ai", company: { name: "Magic Hour AI" } });
    for (const m of MEMBERS) {
      const body = mail.of(m.id)[0].body;
      expect(body.endsWith(`Best regards,\n${m.fullName}\nLinkedIn: ${m.linkedinUrl}\nGitHub: ${m.githubUrl}`)).toBe(true);
      for (const other of MEMBERS.filter((o) => o.id !== m.id)) for (const v of [other.fullName, other.linkedinUrl, other.githubUrl]) expect(body).not.toContain(v);
    }
  });

  it("finds the website from the company name when there is no email, but only when the page names the company", async () => {
    const { research } = researcher({ ...MAGIC_HOUR, "https://magichourai.com/": "<html><title>Totally Unrelated Casino</title></html>", "https://magichour.ai/": MAGIC_HOUR["https://magichour.ai/"].replace("<title>Magic Hour</title>", "<title>Magic Hour AI</title>") });
    const mail = new MockMailboxes();
    await run(research, mail, { company: { name: "Magic Hour AI" } });
    expect(mail.of("lukky")[0].subject).toContain("Machine Learning Engineer");
  });

  it("no verifiable opening: a role-family email, with no invented job and no invented company facts", async () => {
    const { research } = researcher({ "https://magichour.ai/": `<html><head><title>Magic Hour</title></head><body>Welcome</body></html>` });
    const mail = new MockMailboxes();
    await run(research, mail, { email: "jane@magichour.ai", company: { name: "Magic Hour AI" } });
    const d = mail.of("anni")[0];
    expect(d.subject).toMatch(/^Application for .* opportunities — Magic Hour AI$/);
    expect(d.body).not.toMatch(/Your website describes/);
    expect(d.body).not.toMatch(/\b(position|role) at Magic Hour AI\b.*\b(Machine Learning|Frontend)\b/);
  });

  it("nothing can be reached: still a complete, honest draft (no fabricated facts)", async () => {
    const { research } = researcher({});
    const mail = new MockMailboxes();
    await run(research, mail, { email: "jane@magichour.ai", company: { name: "Magic Hour AI" } });
    const d = mail.of("anni")[0];
    expect(d.body).toContain("Magic Hour AI");
    expect(d.body).toContain("opportunities");
    expect(d.body.endsWith("GitHub: https://github.com/iamankoo")).toBe(true);
  });
});

describe("different companies and roles produce materially different drafts", () => {
  const companies = [
    { name: "Neural Nest", role: "AI Engineer", description: "Build LLM integration and RAG pipelines in Python with embeddings and prompt engineering.", about: "Neural Nest builds retrieval systems for legal teams." },
    { name: "Pixel Forge", role: "Frontend Developer", description: "Ship accessible interfaces in React, Next.js and TypeScript with Tailwind CSS and responsive design.", about: "Pixel Forge makes design tools for game studios." },
    { name: "Ledger Works", role: "Backend Engineer", description: "Design REST APIs in Node.js, Express and PostgreSQL with JWT authentication and Redis caching.", about: "Ledger Works runs payment infrastructure for marketplaces." },
  ];

  it("AI/ML vs Frontend vs Backend: each names its own company and role, with different skills and no shared paragraphs except the sign-off", async () => {
    const bodies: string[] = [];
    const subjects: string[] = [];
    for (const c of companies) {
      await createJob("anni", { company: c.name, jobRole: c.role, jobType: "Full-time", location: "Remote", workMode: "Remote", jobUrl: `https://boards.greenhouse.io/${c.name.replace(/\s/g, "").toLowerCase()}/jobs/1`, description: c.description }, new Date(), { notify: false });
      const mail = new MockMailboxes();
      await run(undefined, mail, { company: { name: c.name, website: `https://${c.name.replace(/\s/g, "").toLowerCase()}.test`, description: c.about } });
      const d = mail.of("anni")[0];
      subjects.push(d.subject);
      bodies.push(d.body);
      expect(d.subject).toBe(`Application for ${c.role} — ${c.name}`);
      expect(d.body).toContain(c.name);
      expect(d.body).toContain(c.role);
      expect(d.body).toContain(c.about.replace(/\.$/, ""));
      for (const other of companies.filter((o) => o.name !== c.name)) {
        expect(d.body).not.toContain(other.name);
        expect(d.body).not.toContain(other.role);
      }
    }
    expect(new Set(subjects).size).toBe(3);
    // skills differ with the job
    expect(bodies[0]).toMatch(/LLM|RAG|Python/);
    expect(bodies[1]).toMatch(/Next\.js|Tailwind|TypeScript/);
    expect(bodies[2]).toMatch(/Express|PostgreSQL|Redis|JWT/);
    // no paragraph is shared between two drafts except the generic closing line
    const paras = bodies.map((b) => b.split("\n\n").filter((p) => !/^(Dear|Best regards|Thank you)/.test(p) && !/^I would be glad to share my resume/.test(p)));
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect(paras[i].filter((p) => paras[j].includes(p))).toEqual([]);
  });

  it("the same company, different members: each draft speaks of that member's own skills", async () => {
    await createJob("anni", { company: "Neural Nest", jobRole: "AI Engineer", jobType: "Full-time", location: "Remote", jobUrl: "https://boards.greenhouse.io/neuralnest/jobs/1", description: "LLM integration and RAG pipelines in Python with React dashboards." }, new Date(), { notify: false });
    const mail = new MockMailboxes();
    await run(undefined, mail, { company: { name: "Neural Nest", description: "Neural Nest builds retrieval systems for legal teams." } });
    expect(mail.of("anni")[0].body).toMatch(/Aniket Raj/);
    expect(mail.of("lukky")[0].body).toMatch(/Lakshya Singh/);
    expect(mail.of("anni")[0].body).not.toEqual(mail.of("lukky")[0].body);
  });
});

describe("validation rejects wrong or invented content", () => {
  const plan = (memberId: MemberId = "anni") =>
    buildEmailPlan({
      memberId,
      company: { name: "Magic Hour AI", description: "Magic Hour is an AI video platform that turns text and images into polished videos." },
      person: { name: "Jane Doe", title: "Head of Engineering" },
      job: { title: "Frontend Engineer", description: "Build the editor in React, Next.js and TypeScript with Tailwind." },
    });
  const good = (memberId: MemberId = "anni") => {
    const p = plan(memberId);
    return { p, body: assembleEmail(p, composeFallback(p)) };
  };

  it("the generated fallback itself passes", () => {
    const { p, body } = good();
    expect(validateEmail(body, p)).toEqual([]);
    expect(body).toContain("Frontend Engineer");
    expect(body).toContain("Magic Hour AI");
  });

  it("rejects the wrong role", () => {
    const { p, body } = good();
    const wrong = body.replace(/the Frontend Engineer position/, "the Software Engineer position");
    expect(wrong).not.toBe(body);
    expect(validateEmail(wrong, p).join()).toMatch(/wrong role: Software Engineer|role title missing/);
  });

  it("rejects a draft that does not name the role at all", () => {
    const { p, body } = good();
    expect(validateEmail(body.replaceAll("Frontend Engineer", "developer"), p).join()).toMatch(/role title missing/);
  });

  it("rejects the wrong company", () => {
    const { p, body } = good();
    expect(validateEmail(body.replaceAll("Magic Hour AI", "Some Other Corp"), p).join()).toMatch(/company not mentioned/);
  });

  it("rejects another member's skills, name and links", () => {
    const { p, body } = good("lukky");
    const withAnni = body.replace("Best regards", "Best regards").replace("Lakshya Singh", "Aniket Raj");
    expect(validateEmail(withAnni, p).join()).toMatch(/another member's identity \(anni\)/);
    const links = body.replace("https://github.com/lukkydiwan", "https://github.com/iamankoo");
    expect(validateEmail(links, p).join()).toMatch(/another member's identity \(anni\)/);
    const skill = body.replace(/\n\nI would be glad/, " I also use Kubernetes and Terraform every day.\n\nI would be glad");
    expect(validateEmail(skill, p).join()).toMatch(/unverified skill/);
  });

  it("rejects invented company facts and invented familiarity", () => {
    const { p, body } = good();
    const funding = body.replace(/\n\nI would be glad/, " I read that Magic Hour raised a Series B at a $1 billion valuation.\n\nI would be glad");
    expect(validateEmail(funding, p).join()).toMatch(/unverified company claim/);
    const familiar = body.replace(/\n\nI would be glad/, " Congratulations on your recent launch, I have been following your product for years.\n\nI would be glad");
    expect(validateEmail(familiar, p).join()).toMatch(/invented familiarity/);
  });

  it("rejects a generic paragraph set when company and job specifics were available", () => {
    const { p } = good();
    const generic = assembleEmail(p, [
      "I am writing to express my interest in the Frontend Engineer position at Magic Hour AI. I am a final-year student with experience in building applications and I enjoy solving problems every day with careful engineering.",
      "My technical background includes React, TypeScript, JavaScript, HTML and CSS, and I have worked on several projects where I learned a great deal about shipping dependable work as part of a collaborative group of people.",
      "I am keen to build on my experience in this area and to learn from an experienced team, and I believe that curiosity and discipline will help me to contribute quickly to the group in the months ahead.",
      "I would be glad to share my resume and to discuss how my background aligns with your team needs. I am based in Delhi and available to talk at whatever time suits you best during the coming weeks. Please let me know if a short call, a written exercise or any further information about my background would help you decide whether to take this conversation forward with me over the next few days.",
      "Thank you for taking the time to read this message and for considering my application. I appreciate that you receive many messages every week and I am grateful for any reply, whatever the outcome may turn out to be for me this time around.",
    ]);
    expect(validateEmail(generic, p).join()).toMatch(/does not reflect the company|does not reflect the job requirements/);
  });
});

describe("company research is safe", () => {
  it("never turns an email domain into an internal fetch", () => {
    for (const bad of ["127.0.0.1", "169.254.169.254", "localhost", "db.internal", "printer.local", "10.0.0.5", "a_b.com"]) expect(isPublicHostname(bad), bad).toBe(false);
    expect(isPublicHostname("magichour.ai")).toBe(true);
    expect(websiteCandidates("Acme", "x@169.254.169.254").some((u) => u.includes("169.254"))).toBe(false);
  });

  it("guesses a website only as a candidate to verify, and accepts a page only if it names the company", () => {
    expect(websiteCandidates("Magic Hour AI", "jane@magichour.ai")[0]).toBe("https://magichour.ai/");
    expect(websiteCandidates("Magic Hour AI", "jane@gmail.com")[0]).not.toContain("gmail");
    expect(websiteCandidates("Magic Hour AI")).toContain("https://magichour.ai/");
    expect(pageNamesCompany("<title>Magic Hour</title>", "Magic Hour AI")).toBe(true);
    expect(pageNamesCompany("<title>Cheap Watches</title>", "Magic Hour AI")).toBe(false);
  });
});
