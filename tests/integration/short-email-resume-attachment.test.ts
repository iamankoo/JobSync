/**
 * Short personal emails and the resume attachment on Aniket's Gmail draft. Mock Google + in-memory sheet: nothing real is
 * contacted, nothing is sent, no production data is used.
 */
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/session")>()), getSession: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { POST as addConnection } from "@/app/api/connections/route";
import { GET as connect } from "@/app/api/gmail/connect/route";
import { GET as callback } from "@/app/api/gmail/callback/route";
import type { MemberId } from "@/config/members";
import { GMAIL_COMPOSE_SCOPE } from "@/lib/gmail/config";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { invalidateTableCache } from "@/lib/google-sheets/table";
import { loadNetworkFinderConfig } from "@/lib/network-finder/config";
import type { CompanyResearcher } from "@/lib/network-finder/company-research";
import { existingConnections, existingDraftDeps, existingJobs } from "@/lib/network-finder/gateways";
import { runPendingDrafts, type PipelineDeps } from "@/lib/network-finder/pipeline";
import { createSheetsStores } from "@/lib/network-finder/sheets-stores";
import type { Connection } from "@/types/domain";
import { FakeSheets } from "../helpers/fake-sheets";

let sheets: FakeSheets;
const MEMBERS = ["anni", "lukky", "rishii"] as const;
const FULL: Record<MemberId, string> = { anni: "Aniket Raj", lukky: "Lakshya Singh", rishii: "Rishi Raj" };
const LINKS: Record<MemberId, [string, string]> = {
  anni: ["https://www.linkedin.com/in/raj-aniket/", "https://github.com/iamankoo"],
  lukky: ["https://www.linkedin.com/in/lakshya-singh-243510302/", "https://github.com/lukkydiwan"],
  rishii: ["https://www.linkedin.com/in/rishi-raj-8bb5a8366/", "https://github.com/Rishi-Ra-1j"],
};
const as = (m: MemberId | null) => vi.mocked(getSession).mockResolvedValue(m ? { memberId: m, expiresAt: 9_999_999_999 } : null);
const idToken = (email: string) => `h.${Buffer.from(JSON.stringify({ email, email_verified: true })).toString("base64url")}.s`;

import { addResume } from "@/lib/google-sheets/member-files-service";
import { resumePlanFor, RESUME_BY_ROLE } from "@/config/resume-map";
import { existingResumes } from "@/lib/network-finder/gateways";
import { wordCount } from "@/lib/network-finder/email-composer";

interface Sent {
  mailbox: MemberId;
  id: string;
  subject: string;
  to: string;
  body: string;
  raw: string;
  /** The attachments found in the raw MIME message. */
  files: { name: string; type: string; bytes: Buffer }[];
}

/** Parses the raw RFC 2822 message the app sent to drafts.create (text part + attachments). */
function parseMime(raw: string): { subject: string; to: string; body: string; files: Sent["files"] } {
  const [head, ...rest] = raw.split("\r\n\r\n");
  const header = (n: string) => new RegExp(`^${n}: (.*)$`, "mi").exec(head)?.[1]?.trim() ?? "";
  const subjectRaw = header("Subject");
  const subject = /^=\?UTF-8\?B\?(.+)\?=$/i.test(subjectRaw) ? Buffer.from(subjectRaw.replace(/^=\?UTF-8\?B\?|\?=$/gi, ""), "base64").toString("utf8") : subjectRaw;
  const decode = (b64: string) => Buffer.from(b64.replace(/\r\n/g, ""), "base64");
  const boundary = /boundary="([^"]+)"/.exec(head)?.[1];
  if (!boundary) return { subject, to: header("To"), body: decode(rest.join("\r\n\r\n")).toString("utf8").replace(/\r\n/g, "\n").trimEnd(), files: [] };
  const parts = rest.join("\r\n\r\n").split(`--${boundary}`).slice(1).filter((x) => !x.startsWith("--"));
  let body = "";
  const files: Sent["files"] = [];
  for (const part of parts) {
    const [ph, ...pb] = part.replace(/^\r\n/, "").split("\r\n\r\n");
    const data = decode(pb.join("\r\n\r\n").replace(/\r\n$/, ""));
    const name = /filename="([^"]+)"/.exec(ph)?.[1];
    if (name) files.push({ name, type: /Content-Type: ([^;\r\n]+)/i.exec(ph)?.[1] ?? "", bytes: data });
    else body = data.toString("utf8").replace(/\r\n/g, "\n").trimEnd();
  }
  return { subject, to: header("To"), body, files };
}

function mockGoogle() {
  const drafts: Sent[] = [];
  const failMailbox = new Set<string>();
  const state = { hideAttachmentOnRead: false };
  const urls: string[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "https://oauth2.googleapis.com/token") {
      const p = new URLSearchParams(String(init?.body));
      if (p.get("grant_type") === "authorization_code") {
        const who = p.get("code")!.replace("code-for-", "");
        return Response.json({ access_token: `access-${who}`, refresh_token: `refresh-${who}`, scope: `openid email ${GMAIL_COMPOSE_SCOPE}`, id_token: idToken(`${who}@gmail.example`) });
      }
      return Response.json({ access_token: p.get("refresh_token")!.replace("refresh-", "access-") });
    }
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/drafts" && init?.method === "POST") {
      const who = (init?.headers as Record<string, string>).Authorization.replace("Bearer access-", "");
      if (failMailbox.has(who)) return new Response("boom", { status: 500 });
      const raw = Buffer.from(JSON.parse(String(init?.body)).message.raw, "base64url").toString("utf8");
      const id = `draft-${drafts.length + 1}`;
      drafts.push({ mailbox: who as MemberId, id, raw, ...parseMime(raw) });
      return Response.json({ id, message: { threadId: `thread-${drafts.length}` } });
    }
    const read = /\/drafts\/(draft-\d+)\?format=full$/.exec(url);
    if (read && (init?.method ?? "GET") === "GET") {
      const d = drafts.find((x) => x.id === read[1]);
      if (!d) return new Response("nope", { status: 404 });
      const parts = [{ mimeType: "text/plain", filename: "", body: { size: d.body.length } }, ...(state.hideAttachmentOnRead ? [] : d.files.map((f) => ({ mimeType: f.type, filename: f.name, body: { attachmentId: `att-${d.id}`, size: f.bytes.length } })))];
      return Response.json({ id: d.id, message: { payload: { mimeType: "multipart/mixed", filename: "", parts } } });
    }
    throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
  });
  return { fn, drafts, failMailbox, state, urls };
}
let google: ReturnType<typeof mockGoogle>;

async function connectGmail(m: MemberId) {
  as(m);
  const start = await connect(new NextRequest("http://localhost:3000/api/gmail/connect"));
  const nonce = start.cookies.get("jobsync_gmail_oauth")!.value;
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  await callback(new NextRequest(`http://localhost:3000/api/gmail/callback?code=code-for-${m}&state=${encodeURIComponent(state)}`, { headers: { cookie: `jobsync_gmail_oauth=${nonce}` } }));
}

const ledger = () => sheets.dataRows("NF_Drafts");
const add = async (m: MemberId, body: Record<string, unknown>) => {
  as(m);
  const res = await addConnection(new Request("http://localhost/api/connections", { method: "POST", headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify(body) }));
  expect(res.status).toBe(201);
  return (await res.json()).data as Connection;
};
const FORM = { name: "Siddhi Rao", role: "Talent Partner", email: "siddhi@americanchase.example", company: "American Chase", companyUrl: "https://americanchase.com", roleCategory: "SDE", applyRole: "Software Engineer" };

/** Real-looking, DISTINCT PDF bytes per file, so a wrong or altered attachment is detectable. */
const pdfBytes = (tag: string) => new TextEncoder().encode(`%PDF-1.4\n% ${tag}\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF`);
// (Aniket_Raj_WebD.pdf is deliberately NOT uploaded here, to test a mapped file that is missing.)
const ANIKET_FILES = ["Aniket_Raj_BE.pdf", "Aniket-Raj-AIML.pdf", "Aniket_Raj_SDE.pdf", "Aniket_Raj_Data.pdf"];
async function uploadResumes() {
  for (const f of ANIKET_FILES) await addResume("anni", { bytes: pdfBytes(`anni:${f}`), fileName: f, mimeType: "application/pdf" });
  // The other members' files must never be attached to Aniket's draft, whatever they are called.
  await addResume("lukky", { bytes: pdfBytes("lukky:BE"), fileName: "Aniket_Raj_BE.pdf", mimeType: "application/pdf" });
  await addResume("rishii", { bytes: pdfBytes("rishii:BE"), fileName: "Rishi_BE.pdf", mimeType: "application/pdf" });
}
const memberFilesBefore = () => JSON.stringify(sheets.dataRows("MemberFiles"));

const research: CompanyResearcher = async ({ name }) => ({
  website: "https://americanchase.com/",
  description: `${name} is a technology company building AI-driven solutions and scalable applications for businesses.`,
  jobs: [],
  status: "verified",
});

function workerDeps(resumes = true): PipelineDeps {
  const stores = createSheetsStores();
  return {
    config: loadNetworkFinderConfig({ NETWORK_FINDER_ENABLED: "true", APP_TIMEZONE: "Asia/Kolkata" } as unknown as NodeJS.ProcessEnv),
    sources: [], jobSources: [], research,
    queue: stores.queue, registry: stores.registry, ledger: stores.ledger, selections: stores.selections,
    drafts: existingDraftDeps(), connections: existingConnections, jobs: existingJobs, runState: {},
    ...(resumes ? { resumes: existingResumes } : {}),
  };
}
const work = () => runPendingDrafts(workerDeps(), { limit: 10 });
const of = (m: MemberId) => google.drafts.find((d) => d.mailbox === m)!;
/** Body words without greeting-less signature: everything above "Best regards". */
const bodyWords = (body: string) => wordCount(body.slice(0, body.lastIndexOf("Best regards,")));

beforeEach(async () => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
  invalidateTableCache();
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-client.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "test-client-secret");
  vi.stubEnv("GOOGLE_OAUTH_REDIRECT_URI", "http://localhost:3000/api/gmail/callback");
  vi.stubEnv("GMAIL_TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("NEMOTRON_API_KEY", "");
  google = mockGoogle();
  vi.stubGlobal("fetch", google.fn);
  for (const m of MEMBERS) await connectGmail(m);
  google.drafts.length = 0;
  google.urls.length = 0;
  await uploadResumes();
});
afterEach(() => {
  setSheetsClientForTesting(null);
  vi.mocked(getSession).mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("short, personal emails (about 100-140 words)", () => {
  it("the Software Engineer email for American Chase is short, complete and specific, for each member's own profile", async () => {
    await add("anni", FORM);
    await work();
    expect(google.drafts.map((d) => d.mailbox).sort()).toEqual(["anni", "lukky", "rishii"]);
    for (const m of MEMBERS) {
      const d = of(m);
      expect(d.subject).toBe("Application for Software Engineer — American Chase");
      expect(d.to).toBe("siddhi@americanchase.example");
      expect(d.body.startsWith("Dear Siddhi,")).toBe(true);
      expect(d.body.endsWith(`Best regards,\n${FULL[m]}\nLinkedIn: ${LINKS[m][0]}\nGitHub: ${LINKS[m][1]}`)).toBe(true);
      expect(d.body).toContain("Software Engineer");
      expect(d.body).toContain("American Chase");
      // no unfinished sentences, no research-report phrasing, no placeholders or ellipses
      for (const para of d.body.split("\n\n").slice(0, -1).filter((p) => !/^(Dear|Best regards)/.test(p))) expect(para, para).toMatch(/[.!?]$/);
      expect(d.body).not.toMatch(/Your website describes|according to your website|…|\.\.\.|\{\{/i);
    }
    const a = bodyWords(of("anni").body);
    expect(a).toBeGreaterThanOrEqual(100);
    expect(a).toBeLessThanOrEqual(140);
    expect(bodyWords(of("lukky").body)).toBeGreaterThanOrEqual(100);
    expect(bodyWords(of("lukky").body)).toBeLessThanOrEqual(140);
    expect(bodyWords(of("rishii").body)).toBeLessThanOrEqual(140);
  });

  it("follows the reference structure for Aniket: hello, introduction + role, verified experience, ONE company detail, request, closing", async () => {
    await add("anni", FORM);
    await work();
    const paras = of("anni").body.split("\n\n");
    expect(paras[0]).toBe("Dear Siddhi,");
    expect(paras[1]).toBe("I hope you're doing well.");
    expect(paras[2]).toMatch(/^I'm Aniket Raj, a final-year B\.Tech student in Computer Science \(AI & Data Science\) at IIIT Manipur, and I'm interested in the Software Engineer opportunity at American Chase\.$/);
    expect(paras[3]).toMatch(/Amdox Technologies/);
    expect(paras[4]).toMatch(/^I'm particularly interested in American Chase's work as a technology company building AI-driven solutions/);
    expect(paras[5]).toMatch(/consideration or a referral/);
    expect(paras[6]).toBe("I have attached my resume for your reference. Thank you for your time and consideration.");
    // the company detail is stated once, not repeated
    expect(of("anni").body.match(/AI-driven solutions/g)).toHaveLength(1);
    // no long technology lists: at most a handful of names per sentence
    for (const s of paras[3].split(/(?<=\.)\s/)) expect(s.split(",").length, s).toBeLessThanOrEqual(4);
  });

  it("each member's email uses only that member's own verified facts; an empty profile makes no claims", async () => {
    await add("anni", FORM);
    await work();
    expect(of("anni").body).toMatch(/IIIT Manipur/);
    expect(of("lukky").body).toMatch(/final-year Computer Science Engineering/);
    expect(of("lukky").body).not.toMatch(/IIIT|Amdox|RealPath|Flutter|Docker/);
    expect(of("rishii").body).not.toMatch(/\b(React|Node\.js|Python|MongoDB|IIIT|Amdox|RealPath|student|internship)\b/i);
    expect(new Set(google.drafts.map((d) => d.body)).size).toBe(3);
  });
});

describe("Aniket's resume attachment (mock Gmail; nothing is sent)", () => {
  it("Software Engineer → Aniket_Raj_BE.pdf is attached to Aniket's draft ONLY, with the exact original bytes", async () => {
    const filesBefore = memberFilesBefore();
    const c = await add("anni", FORM);
    await work();
    const a = of("anni");
    expect(a.files).toHaveLength(1);
    expect(a.files[0].name).toBe("Aniket_Raj_BE.pdf");
    expect(a.files[0].type).toBe("application/pdf");
    expect(Buffer.compare(a.files[0].bytes, Buffer.from(pdfBytes("anni:Aniket_Raj_BE.pdf")))).toBe(0); // not Lakshya's identically named file
    expect(a.raw).toMatch(/Content-Disposition: attachment; filename="Aniket_Raj_BE\.pdf"/);
    // the other two members' drafts are unchanged: plain single-part text
    for (const m of ["lukky", "rishii"] as const) {
      expect(of(m).files).toHaveLength(0);
      expect(of(m).raw).not.toMatch(/multipart|attachment/i);
    }
    // recorded in the ledger as verified; everything else says nothing
    const rows = ledger().filter((r) => r[3] === c.connectionId);
    expect(rows.find((r) => r[1] === "anni")![7]).toBe("attached: Aniket_Raj_BE.pdf");
    expect(rows.filter((r) => r[1] !== "anni").every((r) => r[7] === "")).toBe(true);
    // the stored files are untouched: no new, changed or deleted resume
    expect(memberFilesBefore()).toBe(filesBefore);
  });

  it("the attachment is verified by reading the saved draft back; no send, delete or update call is ever made", async () => {
    await add("anni", FORM);
    await work();
    const calls = google.urls.filter((u) => u.includes("gmail.googleapis.com"));
    expect(calls.filter((u) => u.startsWith("POST ")).length).toBe(3); // one drafts.create per member
    expect(calls.filter((u) => u.startsWith("GET ")).length).toBe(1); // read back ONLY Aniket's attached draft
    expect(calls.every((u) => /^(POST .*\/users\/me\/drafts|GET .*\/drafts\/draft-\d+\?format=full)$/.test(u))).toBe(true);
    expect(calls.some((u) => /send|trash|delete|modify|PUT|PATCH/i.test(u))).toBe(false);
  });

  it("each mapped role gets exactly its file; unmapped roles get none (never a guess)", () => {
    const expected: Record<string, string> = {
      "AI/ML Engineer": "Aniket-Raj-AIML.pdf", "AI Engineer": "Aniket-Raj-AIML.pdf", "Applied AI Engineer": "Aniket-Raj-AIML.pdf",
      "Backend Engineer": "Aniket_Raj_BE.pdf", "Backend Developer": "Aniket_Raj_BE.pdf", "Software Engineer": "Aniket_Raj_BE.pdf", "Software Developer": "Aniket_Raj_BE.pdf",
      "Front End Developer": "Aniket_Raj_WebD.pdf", "Full Stack Engineer": "Aniket_Raj_WebD.pdf", "Web Developer": "Aniket_Raj_WebD.pdf",
      "Data Engineer": "Aniket_Raj_Data.pdf",
    };
    for (const [role, file] of Object.entries(expected)) expect(resumePlanFor("anni", role), role).toEqual({ enabled: true, fileName: file });
    expect(Object.keys(RESUME_BY_ROLE.anni!)).toHaveLength(Object.keys(expected).length);
    for (const role of ["Data Analyst", "Data Scientist", "Data Entry", "Agentic AI Engineer", "Machine Learning Engineer", "Python Developer", "App Developer", "Site Reliability Engineer"]) {
      expect(resumePlanFor("anni", role), role).toEqual({ enabled: true });
    }
    // enabled for Aniket only
    for (const m of ["lukky", "rishii"] as const) expect(resumePlanFor(m, "Software Engineer")).toEqual({ enabled: false });
  });

  it("an unmapped role (Machine Learning Engineer): draft created without attachment and flagged; the others unaffected", async () => {
    const c = await add("anni", { ...FORM, roleCategory: "AI/ML", applyRole: "Machine Learning Engineer" });
    await work();
    expect(google.drafts).toHaveLength(3);
    expect(of("anni").files).toHaveLength(0);
    expect(google.urls.some((u) => u.startsWith("GET https://gmail"))).toBe(false);
    const rows = ledger().filter((r) => r[3] === c.connectionId);
    expect(rows.find((r) => r[1] === "anni")![7]).toBe("review: no resume is mapped to this role yet; no attachment");
    expect(rows.filter((r) => r[1] !== "anni").every((r) => r[7] === "")).toBe(true);
  });

  it("Data Engineer → Aniket_Raj_Data.pdf (not the SDE or BE file)", async () => {
    await add("anni", { ...FORM, roleCategory: "Data", applyRole: "Data Engineer" });
    await work();
    expect(of("anni").files.map((f) => f.name)).toEqual(["Aniket_Raj_Data.pdf"]);
    expect(Buffer.compare(of("anni").files[0].bytes, Buffer.from(pdfBytes("anni:Aniket_Raj_Data.pdf")))).toBe(0);
  });

  it("a mapped file that was never uploaded (Web Developer → Aniket_Raj_WebD.pdf) is flagged, not replaced by another file", async () => {
    const c = await add("anni", { ...FORM, roleCategory: "Web D", applyRole: "Web Developer" });
    await work();
    expect(of("anni").files).toHaveLength(0);
    expect(ledger().find((r) => r[3] === c.connectionId && r[1] === "anni")![7]).toBe("review: resume Aniket_Raj_WebD.pdf was not found in the member's uploads; no attachment");
  });

  it("a custom (Other) role never gets a resume", async () => {
    await add("anni", { ...FORM, roleCategory: "Other", applyRole: "Site Reliability Engineer" });
    await work();
    expect(of("anni").files).toHaveLength(0);
  });

  it("two uploads with the mapped name are ambiguous, so none is attached", async () => {
    await addResume("anni", { bytes: pdfBytes("anni:dup"), fileName: "Aniket_Raj_BE.pdf", mimeType: "application/pdf" });
    const c = await add("anni", FORM);
    await work();
    expect(of("anni").files).toHaveLength(0);
    expect(ledger().find((r) => r[3] === c.connectionId && r[1] === "anni")![7]).toMatch(/the mapped resume could not be read \(several uploads are named Aniket_Raj_BE\.pdf\); no attachment/);
  });

  it("if the saved draft cannot be shown to hold the file, the draft is flagged for review (and still never duplicated)", async () => {
    google.state.hideAttachmentOnRead = true;
    const c = await add("anni", FORM);
    await work();
    const row = ledger().find((r) => r[3] === c.connectionId && r[1] === "anni")!;
    expect(row[5]).toBe("created");
    expect(row[7]).toBe("review: resume attachment could not be verified in the saved draft");
    await work();
    expect(google.drafts.filter((d) => d.mailbox === "anni")).toHaveLength(1);
  });

  it("retries and repeated runs create no second draft and never attach twice", async () => {
    await add("anni", FORM);
    await work();
    expect(await work()).toMatchObject({ checked: 0, created: 0 });
    expect(await work()).toMatchObject({ checked: 0, created: 0 });
    expect(google.drafts).toHaveLength(3);
    expect(google.drafts.reduce((n, d) => n + d.files.length, 0)).toBe(1);
    expect(ledger()).toHaveLength(3);
  });

  it("a failed mailbox is retried alone; Aniket's draft (already created, with its file) is not touched", async () => {
    google.failMailbox.add("lukky");
    await add("anni", FORM);
    await work();
    const before = of("anni").raw;
    google.failMailbox.clear();
    await work();
    expect(google.drafts.map((d) => d.mailbox).sort()).toEqual(["anni", "lukky", "rishii"]);
    expect(google.drafts.filter((d) => d.mailbox === "anni")).toHaveLength(1);
    expect(of("anni").raw).toBe(before);
    expect(of("lukky").files).toHaveLength(0);
  });

  it("without the resume step wired in, no draft ever carries an attachment (unchanged behaviour)", async () => {
    await add("anni", FORM);
    await runPendingDrafts(workerDeps(false), { limit: 10 });
    expect(google.drafts).toHaveLength(3);
    expect(google.drafts.every((d) => d.files.length === 0)).toBe(true);
  });
});
