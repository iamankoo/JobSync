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
import { getDraftBacklogGate } from "@/lib/gmail/draft-backlog";
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

import { addResume, deleteResume, listResumes } from "@/lib/google-sheets/member-files-service";
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
  const state = {
    hideAttachmentOnRead: false,
    /** Scripted responses for drafts.send, consumed in order: "ok" (default), a status number, or "timeout-but-sent" / "timeout-not-sent". */
    sendScript: [] as (number | "ok" | "timeout-but-sent" | "timeout-not-sent")[],
    metadata: false,
    /** Mailboxes whose drafts.list answers 500 (the backlog gate must then fail closed). */
    failList: new Set<string>(),
    /** Drafts a member wrote by hand: they are in the Drafts folder but are NOT JobSync-generated (never counted). */
    handwritten: {} as Record<string, number>,
  };
  const sentLog: { mailbox: string; draftId: string; messageId: string; threadId: string; raw: string }[] = [];
  const sentDrafts = new Set<string>();
  const urls: string[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "https://oauth2.googleapis.com/token") {
      const p = new URLSearchParams(String(init?.body));
      if (p.get("grant_type") === "authorization_code") {
        const who = p.get("code")!.replace("code-for-", "");
        return Response.json({ access_token: `access-${who}`, refresh_token: `refresh-${who}`, scope: `openid email ${GMAIL_COMPOSE_SCOPE}${state.metadata ? " https://www.googleapis.com/auth/gmail.metadata" : ""}`, id_token: idToken(`${who}@gmail.example`) });
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
    // drafts.list (what the backlog gate counts): ids of the drafts that are really in THIS mailbox's Drafts folder (sent ones are gone).
    if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/drafts?") && (init?.method ?? "GET") === "GET") {
      const who = (init?.headers as Record<string, string>).Authorization.replace("Bearer access-", "");
      if (state.failList.has(who)) return new Response("boom", { status: 500 });
      const all = [...drafts.filter((d) => d.mailbox === who && !sentDrafts.has(d.id)).map((d) => d.id), ...Array.from({ length: state.handwritten[who] ?? 0 }, (_, i) => `hand-${who}-${i}`)];
      const params = new URL(url).searchParams;
      const start = Number(params.get("pageToken") ?? 0);
      const page = all.slice(start, start + 500);
      return Response.json({ drafts: page.map((id) => ({ id })), ...(start + 500 < all.length ? { nextPageToken: String(start + 500) } : {}) });
    }
    const read = /\/drafts\/(draft-\d+)\?format=full$/.exec(url);
    if (read && (init?.method ?? "GET") === "GET") {
      const d = drafts.find((x) => x.id === read[1]);
      if (!d || sentDrafts.has(d.id)) return new Response("nope", { status: 404 });
      const parts = [{ mimeType: "text/plain", filename: "", body: { size: d.body.length, data: Buffer.from(d.body, "utf8").toString("base64url") } }, ...(state.hideAttachmentOnRead ? [] : d.files.map((f) => ({ mimeType: f.type, filename: f.name, body: { attachmentId: `att-${d.id}`, size: f.bytes.length } })))];
      return Response.json({ id: d.id, message: { threadId: `thread-${drafts.indexOf(d) + 1}`, payload: { mimeType: "multipart/mixed", filename: "", headers: [{ name: "To", value: d.to }, { name: "Subject", value: d.subject }], parts } } });
    }
    const minimal = /\/drafts\/(draft-\d+)\?format=minimal$/.exec(url);
    if (minimal && (init?.method ?? "GET") === "GET") {
      const d = drafts.find((x) => x.id === minimal[1]);
      return !d || sentDrafts.has(d.id) ? new Response("gone", { status: 404 }) : Response.json({ id: d.id });
    }
    const thread = /\/threads\/(thread-\d+)\?format=minimal$/.exec(url);
    if (thread && (init?.method ?? "GET") === "GET") {
      const sent = sentLog.find((x) => x.threadId === thread[1]);
      return sent ? Response.json({ id: thread[1], messages: [{ id: sent.messageId, labelIds: ["SENT"] }] }) : Response.json({ id: thread[1], messages: [{ id: "m-draft", labelIds: ["DRAFT"] }] });
    }
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send" && init?.method === "POST") {
      const who = (init?.headers as Record<string, string>).Authorization.replace("Bearer access-", "");
      const draftId = JSON.parse(String(init?.body)).id as string;
      const d = drafts.find((x) => x.id === draftId && x.mailbox === who);
      const script = state.sendScript.shift() ?? "ok";
      const doSend = () => {
        if (!d || sentDrafts.has(d.id)) return null;
        sentDrafts.add(d.id);
        const rec = { mailbox: who, draftId, messageId: `msg-${sentLog.length + 1}`, threadId: `thread-${drafts.indexOf(d) + 1}`, raw: d.raw };
        sentLog.push(rec);
        return rec;
      };
      if (typeof script === "number") return script === 429 ? new Response(JSON.stringify({ error: { errors: [{ reason: "rateLimitExceeded" }] } }), { status: 429, headers: { "retry-after": "120" } }) : new Response(JSON.stringify({ error: { message: "x" } }), { status: script });
      if (script === "timeout-but-sent") { doSend(); throw new Error("socket hang up"); }
      if (script === "timeout-not-sent") throw new Error("socket hang up");
      if (!d) return new Response("nope", { status: 404 });
      const rec = doSend();
      return rec ? Response.json({ id: rec.messageId, threadId: rec.threadId, labelIds: ["SENT"] }) : new Response("nope", { status: 404 });
    }
    throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
  });
  return { fn, drafts, failMailbox, state, urls, sentLog, sentDrafts };
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
// Each member's role resumes as in Profile -> My Resumes (WebD and DevOps are deliberately NOT uploaded for anyone here, to test the
// same-member SDE fallback). Decoys: files of ANOTHER member that carry a name the first member also uses.
const OWN_FILES: Record<MemberId, string[]> = {
  anni: ["Aniket_Raj_SDE.pdf", "Aniket-Raj-AIML.pdf", "Aniket_Raj_Data.pdf"],
  lukky: ["Lakshya_SDE.pdf", "Lakshya_AiMl.pdf"],
  rishii: ["Rishi_Raj_SDE.pdf", "Rishi_Raj_AIML.pdf"],
};
async function uploadResumes() {
  for (const m of MEMBERS) for (const f of OWN_FILES[m]) await addResume(m, { bytes: pdfBytes(`${m}:${f}`), fileName: f, mimeType: "application/pdf" });
  // Another member's identically named files must never reach anyone else's draft.
  await addResume("lukky", { bytes: pdfBytes("lukky:decoy-anni-sde"), fileName: "Aniket_Raj_SDE.pdf", mimeType: "application/pdf" });
  await addResume("rishii", { bytes: pdfBytes("rishii:decoy-lukky-sde"), fileName: "Lakshya_SDE.pdf", mimeType: "application/pdf" });
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
  getDraftBacklogGate().invalidate(); // the process-wide gate caches its count: every test starts from a fresh one
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

const att = (m: MemberId) => of(m).files.map((f) => f.name);
const sameBytes = (m: MemberId, file: string) => Buffer.compare(of(m).files[0].bytes, Buffer.from(pdfBytes(`${m}:${file}`))) === 0;
const detailOf = (cid: string, m: MemberId) => ledger().find((r) => r[3] === cid && r[1] === m)![7];

describe("resume attachment for all three members (mock Gmail; nothing is sent)", () => {
  it("Software Engineer -> every member's OWN SDE resume, byte-exact, on their own draft only", async () => {
    const filesBefore = memberFilesBefore();
    const c = await add("anni", FORM);
    await work();
    expect(att("anni")).toEqual(["Aniket_Raj_SDE.pdf"]);
    expect(att("lukky")).toEqual(["Lakshya_SDE.pdf"]);
    expect(att("rishii")).toEqual(["Rishi_Raj_SDE.pdf"]);
    expect(sameBytes("anni", "Aniket_Raj_SDE.pdf")).toBe(true); // not Lakshya's decoy of the same name
    expect(sameBytes("lukky", "Lakshya_SDE.pdf")).toBe(true); // not Rishi's decoy
    expect(sameBytes("rishii", "Rishi_Raj_SDE.pdf")).toBe(true);
    for (const m of MEMBERS) {
      expect(of(m).raw).toContain(`Content-Disposition: attachment; filename="${att(m)[0]}"`);
      expect(detailOf(c.connectionId, m)).toBe(`attached: ${att(m)[0]}`);
    }
    expect(memberFilesBefore()).toBe(filesBefore); // stored files untouched
  });

  it("AI/ML roles -> each member's AIML resume", async () => {
    await add("anni", { ...FORM, roleCategory: "AI/ML", applyRole: "AI Engineer" });
    await work();
    expect([att("anni"), att("lukky"), att("rishii")]).toEqual([["Aniket-Raj-AIML.pdf"], ["Lakshya_AiMl.pdf"], ["Rishi_Raj_AIML.pdf"]]);
    for (const m of MEMBERS) expect(sameBytes(m, att(m)[0])).toBe(true);
  });

  it("Data Engineer -> Aniket's Data resume; Lakshya and Rishi have none, so THEIR OWN SDE resume, with the reason recorded", async () => {
    const c = await add("anni", { ...FORM, roleCategory: "Data", applyRole: "Data Engineer" });
    await work();
    expect(att("anni")).toEqual(["Aniket_Raj_Data.pdf"]);
    expect(att("lukky")).toEqual(["Lakshya_SDE.pdf"]);
    expect(att("rishii")).toEqual(["Rishi_Raj_SDE.pdf"]);
    expect(detailOf(c.connectionId, "anni")).toBe("attached: Aniket_Raj_Data.pdf");
    expect(detailOf(c.connectionId, "lukky")).toBe("resume: Data resume unavailable (no Data resume is mapped for this member); the member's SDE resume was used; attached: Lakshya_SDE.pdf");
    expect(detailOf(c.connectionId, "rishii")).toMatch(/SDE resume was used; attached: Rishi_Raj_SDE\.pdf$/);
  });

  it("Web Developer (no WebD upload for anyone here) -> that same member's SDE resume, never another member's file", async () => {
    await add("anni", { ...FORM, roleCategory: "Web D", applyRole: "Web Developer" });
    await work();
    expect([att("anni"), att("lukky"), att("rishii")]).toEqual([["Aniket_Raj_SDE.pdf"], ["Lakshya_SDE.pdf"], ["Rishi_Raj_SDE.pdf"]]);
  });

  it("a custom Other role (Site Reliability Engineer = DevOps kind, no DevOps upload) falls back to each member's SDE resume", async () => {
    await add("anni", { ...FORM, roleCategory: "Other", applyRole: "Site Reliability Engineer" });
    await work();
    expect([att("anni"), att("lukky"), att("rishii")]).toEqual([["Aniket_Raj_SDE.pdf"], ["Lakshya_SDE.pdf"], ["Rishi_Raj_SDE.pdf"]]);
  });

  it("an ambiguous resume (two uploads with the chosen name) is NOT attached: that draft is flagged, the others are unaffected", async () => {
    await addResume("lukky", { bytes: pdfBytes("lukky:dup"), fileName: "Lakshya_SDE.pdf", mimeType: "application/pdf" });
    const c = await add("anni", FORM);
    await work();
    expect(att("lukky")).toEqual([]);
    expect(detailOf(c.connectionId, "lukky")).toBe("review: no usable resume (several uploads are named Lakshya_SDE.pdf (ambiguous)); no attachment");
    expect(att("anni")).toEqual(["Aniket_Raj_SDE.pdf"]);
    expect(att("rishii")).toEqual(["Rishi_Raj_SDE.pdf"]);
  });

  it("an ambiguous specialised resume falls back to the same member's unambiguous SDE resume", async () => {
    await addResume("rishii", { bytes: pdfBytes("rishii:dup"), fileName: "Rishi_Raj_AIML.pdf", mimeType: "application/pdf" });
    const c = await add("anni", { ...FORM, roleCategory: "AI/ML", applyRole: "AI/ML Engineer" });
    await work();
    expect(att("rishii")).toEqual(["Rishi_Raj_SDE.pdf"]);
    expect(detailOf(c.connectionId, "rishii")).toBe("resume: AIML resume unavailable (several uploads are named Rishi_Raj_AIML.pdf (ambiguous)); the member's SDE resume was used; attached: Rishi_Raj_SDE.pdf");
  });

  it("each saved draft is read back to verify the attachment; no send, delete or update call is ever made", async () => {
    await add("anni", FORM);
    await work();
    const all = google.urls.filter((u) => u.includes("gmail.googleapis.com"));
    // The backlog gate counts the members' Drafts folders with read-only drafts.list calls (ids only); they are the only other Gmail calls.
    const lists = all.filter((u) => /^GET https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/drafts\?maxResults=500&fields=/.test(u));
    expect(lists.length).toBeGreaterThanOrEqual(3);
    const calls = all.filter((u) => !lists.includes(u));
    expect(calls.filter((u) => u.startsWith("POST ")).length).toBe(3);
    expect(calls.filter((u) => u.startsWith("GET ")).length).toBe(3); // every attached draft is read back
    expect(calls.every((u) => /^(POST .*\/users\/me\/drafts|GET .*\/drafts\/draft-\d+\?format=full)$/.test(u))).toBe(true);
    expect(calls.some((u) => /send|trash|delete|modify|PUT|PATCH/i.test(u))).toBe(false);
  });

  it("if a saved draft cannot be shown to hold the file, it is flagged for review (and never duplicated)", async () => {
    google.state.hideAttachmentOnRead = true;
    const c = await add("anni", FORM);
    await work();
    for (const m of MEMBERS) {
      const row = ledger().find((r) => r[3] === c.connectionId && r[1] === m)!;
      expect(row[5]).toBe("created");
      expect(row[7]).toBe("review: resume attachment could not be verified in the saved draft");
    }
    await work();
    expect(google.drafts).toHaveLength(3);
  });

  it("retries and repeated runs create no second draft and never attach twice", async () => {
    await add("anni", FORM);
    await work();
    expect(await work()).toMatchObject({ checked: 0, created: 0 });
    expect(await work()).toMatchObject({ checked: 0, created: 0 });
    expect(google.drafts).toHaveLength(3);
    expect(google.drafts.every((d) => d.files.length === 1)).toBe(true);
    expect(ledger()).toHaveLength(3);
  });

  it("a failed mailbox is retried alone; drafts already created (with their files) are not touched", async () => {
    google.failMailbox.add("lukky");
    await add("anni", FORM);
    await work();
    const before = of("anni").raw;
    google.failMailbox.clear();
    await work();
    expect(google.drafts.map((d) => d.mailbox).sort()).toEqual(["anni", "lukky", "rishii"]);
    expect(of("anni").raw).toBe(before);
    expect(att("lukky")).toEqual(["Lakshya_SDE.pdf"]);
  });

  it("without the resume step wired in, no draft ever carries an attachment (unchanged behaviour)", async () => {
    await add("anni", FORM);
    await runPendingDrafts(workerDeps(false), { limit: 10 });
    expect(google.drafts).toHaveLength(3);
    expect(google.drafts.every((d) => d.files.length === 0)).toBe(true);
  });
});

// ---- Part 2: the unified outreach pipeline end to end (mock Gmail, in-memory sheets; nothing is sent) ------------------------------

import { isGmailConnected } from "@/lib/gmail/drafts";
import { readDraftLedger } from "@/lib/gmail/store";
import { loadOutreachConfig } from "@/lib/outreach/config";
import { buildRealSendDeps, realConnectionsPort, runOutreachCycle, type CycleDeps } from "@/lib/outreach/run";
import { TRACKING_TAB, COUNTERS_TAB } from "@/lib/outreach/types";
import { masterRow, masterGrid, newOutreachSpreadsheet } from "../helpers/outreach";

describe("unified outreach pipeline: Outreach Database + manual connections -> one worker -> per-member drafts", () => {
  let outreach: ReturnType<typeof newOutreachSpreadsheet>;
  const cycleDeps = (over: Partial<CycleDeps> = {}, env: Record<string, string> = { OUTREACH_ENABLED: "true", OUTREACH_SPREADSHEET_ID: "outreach-test" }): CycleDeps => ({
    config: loadOutreachConfig(env as unknown as NodeJS.ProcessEnv),
    sheet: outreach.sheet,
    connections: realConnectionsPort,
    ledger: async () => new Map([...(await readDraftLedger({ fresh: true })).entries()].map(([k, v]) => [k, { status: v.status, detail: v.detail }])),
    connected: async () => {
      const out: MemberId[] = [];
      for (const m of MEMBERS) if (await isGmailConnected(m)) out.push(m);
      return out;
    },
    draft: async (limit) => runPendingDrafts(workerDeps(), { limit }),
    now: () => new Date("2026-11-05T05:00:00.000Z"),
    timezone: "Asia/Kolkata",
    ...over,
  });
  const tracking = () => outreach.fake.dataRows(TRACKING_TAB).filter((r) => r[0]);
  const draftsFor = (email: string) => google.drafts.filter((d) => d.to === email);

  beforeEach(async () => {
    outreach = newOutreachSpreadsheet(
      masterGrid([
        masterRow({ PersonEmail: "full@acme.example.com", PersonName: "Fiona Full", CompanyName: "Acme Robotics", PrimaryRoleCategory: "AI Engineer", RoleBasis: "company-inferred" }),
        masterRow({ PersonEmail: "careers@bolt.example.com", PersonName: "", CompanyName: "Bolt Software" }),
        masterRow({ PersonEmail: "pat@nocompany.example.com", PersonName: "Pat Person", CompanyName: "" }),
        masterRow({ PersonEmail: "info@mystery.example.com", PersonName: "", CompanyName: "" }),
      ]),
    );
  });

  it("imports all four segments, drafts them in all three mailboxes with the right greeting, company wording and resume, and tracks everything", async () => {
    const r = await runOutreachCycle(cycleDeps());
    expect(r.errors).toEqual([]);
    expect(r.import).toMatchObject({ importedThisRun: 4 });
    // drafting is bounded per call (OUTREACH_DRAFTS_PER_RUN=2): three calls finish four contacts
    for (let i = 0; i < 3; i++) await runOutreachCycle(cycleDeps());
    expect(google.drafts).toHaveLength(12);

    for (const m of MEMBERS) {
      const a = draftsFor("full@acme.example.com").find((d) => d.mailbox === m)!;
      expect(a.body.startsWith("Dear Fiona,")).toBe(true);
      expect(a.subject).toContain("Acme Robotics");
      const b = draftsFor("careers@bolt.example.com").find((d) => d.mailbox === m)!;
      expect(b.body.startsWith("Dear Hiring Team,")).toBe(true);
      expect(b.subject).toContain("Bolt Software");
      const c = draftsFor("pat@nocompany.example.com").find((d) => d.mailbox === m)!;
      expect(c.body.startsWith("Dear Pat,")).toBe(true);
      expect(c.subject).toContain("your company");
      expect(c.body).toContain("at your company");
      const d = draftsFor("info@mystery.example.com").find((x) => x.mailbox === m)!;
      expect(d.body.startsWith("Dear Hiring Team,")).toBe(true);
      expect(d.body).toContain("at your company");
      for (const draft of [a, b, c, d]) {
        expect(bodyWords(draft.body)).toBeLessThanOrEqual(150);
        expect(draft.body).not.toMatch(/\{\{|undefined|null|your team/);
        expect(draft.files).toHaveLength(1); // every member always has at least their own SDE resume
        expect(draft.files[0].name).toBe(m === "anni" ? (draft === a ? "Aniket-Raj-AIML.pdf" : "Aniket_Raj_SDE.pdf") : m === "lukky" ? (draft === a ? "Lakshya_AiMl.pdf" : "Lakshya_SDE.pdf") : draft === a ? "Rishi_Raj_AIML.pdf" : "Rishi_Raj_SDE.pdf");
      }
    }
    // tracking: every contact drafted in all three mailboxes, nothing sent
    const rows = tracking();
    expect(rows).toHaveLength(4);
    expect(rows.every((t) => t[3] === "added" && t[13] === "drafted" && t[14] === "created" && t[15] === "created" && t[16] === "created" && t[21] === "disabled")).toBe(true);
    expect(google.urls.some((u) => /send|trash|delete|modify/i.test(u.replace("drafts", "")))).toBe(false);
    // counters derived from tracking
    const counters = outreach.fake.dataRows(COUNTERS_TAB).at(-1)!;
    expect(counters.slice(0, 10)).toEqual(["2026-11-05", "4", "4", "12", "0", "0", "0", "0", "0", "0"]);
  });

  it("a manually added connection enters the SAME pipeline, is processed once, and is never imported again", async () => {
    outreach = newOutreachSpreadsheet(masterGrid([masterRow({ PersonEmail: "dup@acme.example.com", PersonName: "Dee Dup", CompanyName: "Acme" })]));
    const c = await add("lukky", { ...FORM, email: "dup@acme.example.com", name: "Dee Dup", company: "Acme" });
    for (let i = 0; i < 3; i++) await runOutreachCycle(cycleDeps());
    expect(google.drafts).toHaveLength(3);
    expect(tracking()).toHaveLength(1);
    expect(tracking()[0].slice(0, 6)).toEqual([expect.stringMatching(/^HRC-/), "dup@acme.example.com", "manual", "added", c.connectionId, "lukky"]);
    expect(tracking()[0][13]).toBe("drafted");
    expect(ledger()).toHaveLength(3);
  });

  it("imported and manual contacts together: each person is drafted exactly once per mailbox across repeated cron calls", async () => {
    await add("rishii", { ...FORM, email: "manual@zed.example.com", name: "Max Manual", company: "Zed" });
    for (let i = 0; i < 6; i++) await runOutreachCycle(cycleDeps());
    expect(google.drafts).toHaveLength(15); // 4 imported + 1 manual, 3 mailboxes each
    expect(new Set(google.drafts.map((d) => `${d.mailbox}:${d.to}`)).size).toBe(15);
    expect(tracking()).toHaveLength(5);
  });

  it("a failing mailbox leaves the contact 'drafting' (no false counts) and it is completed on a later call", async () => {
    google.failMailbox.add("rishii");
    for (let i = 0; i < 3; i++) await runOutreachCycle(cycleDeps());
    const mid = tracking();
    expect(mid.every((t) => t[13] === "drafting" && t[16] === "failed")).toBe(true);
    const c1 = outreach.fake.dataRows(COUNTERS_TAB).at(-1)!;
    expect(c1[3]).toBe("8"); // only the 8 drafts that really exist
    google.failMailbox.clear();
    for (let i = 0; i < 4; i++) await runOutreachCycle(cycleDeps());
    expect(tracking().every((t) => t[13] === "drafted")).toBe(true);
    expect(outreach.fake.dataRows(COUNTERS_TAB).at(-1)![3]).toBe("12");
    expect(google.drafts).toHaveLength(12);
  });

  it("a draft that needs a person's attention is reported as needs_review with its reason", async () => {
    await runOutreachCycle(cycleDeps());
    // a member deletes nothing; force a review flag by hiding attachment verification
    google.state.hideAttachmentOnRead = true;
    for (let i = 0; i < 3; i++) await runOutreachCycle(cycleDeps());
    const rows = tracking();
    expect(rows.some((t) => t[13] === "needs_review" && /resume attachment could not be verified/.test(t[20]))).toBe(true);
    expect(Number(outreach.fake.dataRows(COUNTERS_TAB).at(-1)![6])).toBeGreaterThan(0);
  });

  it("is OFF unless enabled, refuses a second concurrent worker, and writes nothing when disabled", async () => {
    const off = await runOutreachCycle(cycleDeps({}, { OUTREACH_ENABLED: "false" }));
    expect(off).toMatchObject({ ran: false, reason: "disabled" });
    expect(connections()).toHaveLength(0);
    await outreach.sheet.ensureTabs();
    await outreach.sheet.acquireLock(Date.now(), 60_000);
    const busy = await runOutreachCycle(cycleDeps({ now: () => new Date() }));
    expect(busy).toMatchObject({ ran: false, reason: "busy" });
    expect(connections()).toHaveLength(0);
  });
});
const connections = () => sheets.dataRows("Connections");

describe("company wording and research for imported contacts", () => {
  it("uses the company's own description from the Outreach Database when live research is unavailable; no 'research unavailable' flag", async () => {
    const { createConnection } = await import("@/lib/google-sheets/connections-service");
    const { createConnectionSchema } = await import("@/lib/validation/connections");
    const c = await createConnection("anni", createConnectionSchema.parse({
      name: "Dee Dee", company: "Zenith Labs", email: "dee@zenith.example.com", roleCategory: "SDE", applyRole: "Software Engineer", status: "Not Connected",
      notes: "Source: Outreach Database HRC-AAAAAAAAAAAA\nCompany description (from the company's website): Zenith Labs builds payment infrastructure for online merchants.",
    }));
    const calls: string[] = [];
    const deps = { ...workerDeps(), research: (async ({ name }: { name: string }) => { calls.push(name); return { status: "unavailable", jobs: [] }; }) as unknown as CompanyResearcher };
    await runPendingDrafts(deps, { limit: 10 });
    expect(google.drafts).toHaveLength(3);
    for (const d of google.drafts) expect(d.body).toContain("payment infrastructure for online merchants");
    for (const m of MEMBERS) expect(ledger().find((r) => r[3] === c.connectionId && r[1] === m)![7]).not.toMatch(/company research unavailable/);
  });

  it("never researches the 'your company' fallback as if it were a company; the draft says so as a note, not a review flag", async () => {
    const { createConnection } = await import("@/lib/google-sheets/connections-service");
    const { createConnectionSchema } = await import("@/lib/validation/connections");
    const c = await createConnection("lukky", createConnectionSchema.parse({ name: "Hiring Team", email: "info@unknown.example.com", roleCategory: "AI/ML", applyRole: "AI Engineer", status: "Not Connected" }));
    const calls: string[] = [];
    const deps = { ...workerDeps(), research: (async ({ name }: { name: string }) => { calls.push(name); return { status: "unavailable", jobs: [] }; }) as unknown as CompanyResearcher };
    await runPendingDrafts(deps, { limit: 10 });
    expect(calls).toEqual([]);
    expect(google.drafts).toHaveLength(3);
    for (const d of google.drafts) {
      expect(d.body.startsWith("Dear Hiring Team,")).toBe(true);
      expect(d.body).toContain("at your company");
      expect(d.subject).toBe("Application for AI Engineer — your company");
    }
    const detail = ledger().find((r) => r[3] === c.connectionId && r[1] === "anni")![7];
    expect(detail).toMatch(/^note: company name unknown; generic company wording was used/);
    expect(detail).not.toMatch(/review:/);
  });
});


// ---- Part 3: the send workflow with the REAL Gmail adapters against a MOCK Gmail server (nothing real is contacted or sent) ---------------

import { reconcileDraftSend, readDraftFor, sendDraftFor } from "@/lib/gmail/send";
import { readGmailAccounts, recordDraft } from "@/lib/gmail/store";
import { updateConnection } from "@/lib/google-sheets/connections-service";
import { runSendStep, type SendDeps } from "@/lib/outreach/send-workflow";
import { computeCounters } from "@/lib/outreach/sync";

describe("send workflow with the real Gmail adapters (mock Gmail server)", () => {
  let outreach: ReturnType<typeof newOutreachSpreadsheet>;
  const CONTACTS = [
    masterRow({ PersonEmail: "full@acme.example.com", PersonName: "Fiona Full", CompanyName: "Acme Robotics", PrimaryRoleCategory: "AI Engineer", RoleBasis: "company-inferred" }),
    masterRow({ PersonEmail: "careers@bolt.example.com", PersonName: "", CompanyName: "Bolt Software" }),
    masterRow({ PersonEmail: "pat@nocompany.example.com", PersonName: "Pat Person", CompanyName: "" }),
    masterRow({ PersonEmail: "info@mystery.example.com", PersonName: "", CompanyName: "" }),
  ];
  const T0 = new Date("2026-11-05T05:00:00.000Z");
  let clock = T0;

  const cycle = (over: Partial<CycleDeps> = {}): CycleDeps => ({
    config: loadOutreachConfig({ OUTREACH_ENABLED: "true", OUTREACH_SPREADSHEET_ID: "outreach-test" } as unknown as NodeJS.ProcessEnv),
    sheet: outreach.sheet,
    connections: realConnectionsPort,
    ledger: async () => new Map([...(await readDraftLedger({ fresh: true })).entries()].map(([k, v]) => [k, { status: v.status, detail: v.detail, gmailDraftId: v.gmailDraftId, ...(v.threadId ? { threadId: v.threadId } : {}) }])),
    connected: async () => MEMBERS.filter(() => true),
    draft: async (limit) => runPendingDrafts(workerDeps(), { limit }),
    now: () => clock,
    timezone: "Asia/Kolkata",
    ...over,
  });

  const sendDeps = (over: Partial<SendDeps> = {}): SendDeps => ({
    gate: true,
    sheet: outreach.sheet,
    gmail: {
      address: async (m) => (await readGmailAccounts({ fresh: true })).find((a) => a.memberId === m && a.status === "connected")?.email ?? null,
      readDraft: (m, id) => readDraftFor(m, id),
      send: (m, id) => sendDraftFor(m, id),
      reconcile: (m, d, t) => reconcileDraftSend(m, d, t),
    },
    resumes: existingResumes,
    connections: { listFresh: realConnectionsPort.listFresh, markMessaged: async (c) => { await updateConnection(c.memberId, c.connectionId, { status: "Messaged" }); } },
    drafts: {
      snapshot: async () => new Map([...(await readDraftLedger({ fresh: true })).entries()].map(([k, v]) => [k, { status: v.status, detail: v.detail, gmailDraftId: v.gmailDraftId, ...(v.threadId ? { threadId: v.threadId } : {}) }])),
      markSent: async (m, connectionId) => {
        const cur = (await readDraftLedger({ fresh: true })).get(`contact:${connectionId}:${m}`);
        if (cur) await recordDraft({ ...cur, status: "sent", checkedAt: clock.toISOString() });
      },
    },
    now: () => clock,
    timezone: "Asia/Kolkata",
    ...over,
  });

  const tracking = () => outreach.fake.dataRows("Added in Outreach Emails").filter((r) => r[0]);
  const ledgerRows = () => outreach.fake.dataRows("Outreach Send Ledger").filter((r) => r[0]);
  const sendPosts = () => google.urls.filter((u) => u === "POST https://gmail.googleapis.com/gmail/v1/users/me/drafts/send");

  beforeEach(async () => {
    clock = T0;
    outreach = newOutreachSpreadsheet(masterGrid(CONTACTS));
    for (let i = 0; i < 3; i++) await runOutreachCycle(cycle()); // import + draft (a few bounded calls)
    expect(google.drafts).toHaveLength(12);
    google.urls.length = 0;
    clock = new Date("2026-11-06T06:00:00.000Z");
  });

  it("one shared Connection -> THREE separately personalised e-mails, each sent from that member's OWN Gmail with that member's OWN resume (4 contacts -> 12 sends)", async () => {
    const r = await runSendStep(sendDeps());
    expect(r).toMatchObject({ status: "ran", sent: 12, errors: [] });
    expect(google.sentLog).toHaveLength(12);
    for (const [email] of tracking().map((t) => [t[1]])) {
      const sent = google.sentLog.filter((x) => google.drafts.find((d) => d.id === x.draftId)!.to === email);
      expect(sent.map((x) => x.mailbox).sort(), email).toEqual(["anni", "lukky", "rishii"]); // the same recipient, one e-mail from each account
      for (const x of sent) {
        const d = google.drafts.find((y) => y.id === x.draftId)!;
        expect(d.mailbox).toBe(x.mailbox); // sent from the member whose draft it is
        expect(d.files).toHaveLength(1);
        expect(d.files[0].name).toMatch(x.mailbox === "anni" ? /^Aniket/ : x.mailbox === "lukky" ? /^Lakshya/ : /^Rishi/); // never another member's resume
      }
    }
    expect(google.drafts.filter((d) => !google.sentDrafts.has(d.id))).toHaveLength(0);
    // tracking (one row per contact) + ledger (one row per member and recipient) + Connections
    expect(tracking().every((t) => t[21] === "sent" && t[26] === "anni,lukky,rishii" && t[27].split(",").length === 3 && t[27].split(",").every((a: string) => /@gmail\.example$/.test(a)) && /^msg-\d+(,msg-\d+){2}$/.test(t[28]) && t[29].split("; ").length === 3)).toBe(true);
    expect(ledgerRows()).toHaveLength(12);
    expect(new Set(ledgerRows().map((l) => l[0])).size).toBe(12); // member|recipient keys are all distinct
    expect(ledgerRows().every((l) => /^[0-9a-f]{64}$/.test(l[10]) && Number(l[11]) > 0 && l[14].startsWith("msg-") && l[19] === "2026-11-06")).toBe(true);
    for (const c of (await realConnectionsPort.listFresh())) expect(c.status).toBe("Messaged");
    // exact message identity: the sent message IS the verified draft
    for (const x of google.sentLog) expect(x.raw).toBe(google.drafts.find((d) => d.id === x.draftId)!.raw);
  });

  it("counters count only confirmed sends, per day and per member", async () => {
    await runSendStep(sendDeps());
    const { records } = await outreach.sheet.readTracking();
    const { records: ledger } = await outreach.sheet.readSendLedger();
    const c = computeCounters(records, "2026-11-06", 0, { ledger });
    expect(c.sentToday).toBe(12);
    expect(c.sentTodayByMember).toEqual({ anni: 4, lukky: 4, rishii: 4 }); // independent per-member counts; one Connection is three sends, not one
    expect(computeCounters(records, "2026-11-07", 0, { ledger }).sentToday).toBe(0);
  });

  it("repeated cron runs never send again (idempotent), even after drafts are re-listed", async () => {
    await runSendStep(sendDeps());
    for (let i = 0; i < 3; i++) await runSendStep(sendDeps());
    expect(sendPosts()).toHaveLength(12);
    expect(google.sentLog).toHaveLength(12);
  });

  it("quota (429): nothing sent, nothing counted, retried after the back-off; the success is recorded once", async () => {
    google.state.sendScript = [429];
    const r = await runSendStep(sendDeps());
    // Gmail's quota applies to ONE member's account: that member pauses (nothing more is attempted from it), the other two keep sending.
    expect(r).toMatchObject({ sent: 8, failed: 1, stoppedBecause: "rate-limited" });
    expect(ledgerRows()[0][3]).toBe("failed_transient");
    const limited = ledgerRows()[0][4];
    expect(google.sentLog.every((x) => x.mailbox !== limited)).toBe(true); // nothing was sent from the rate-limited account
    expect(google.sentLog).toHaveLength(8);
    expect(sendPosts()).toHaveLength(9); // 8 sends + the single refused attempt: the limited account was not hammered
    expect(new Date(ledgerRows()[0][17]).getTime()).toBe(clock.getTime() + 15 * 60_000);
    clock = new Date(clock.getTime() + 20 * 60_000);
    expect((await runSendStep(sendDeps())).sent).toBe(4); // cool-down over: the limited member's e-mails now go out
    expect(google.sentLog).toHaveLength(12);
  });

  it("authentication failure (401): nothing sent or counted for that member, who is flagged for re-authorisation; the OTHER members still send", async () => {
    google.state.sendScript = [401];
    const r = await runSendStep(sendDeps());
    expect(r.failed).toBe(1);
    const failing = ledgerRows().find((l) => l[3] === "failed_transient")!;
    const bad = failing[4];
    expect(r.sent).toBe(8); // 4 contacts x the two healthy members
    expect(google.sentLog).toHaveLength(8);
    expect(google.sentLog.every((x) => x.mailbox !== bad)).toBe(true);
    const first = tracking().find((t) => t[21] === "failed")!;
    expect(first[25]).toMatch(/\[gmail_auth\]/);
    expect(first[23]).toBe("auth");
    expect(tracking().every((t) => t[21] !== "sent")).toBe(true); // no contact is finished without the failing member's e-mail
    expect((await readGmailAccounts({ fresh: true })).find((a) => a.memberId === bad)!.status).toBe("reauth_required");
  });

  it("invalid recipient (400 from Gmail): flagged for review, never retried", async () => {
    google.state.sendScript = [400];
    await runSendStep(sendDeps());
    expect(ledgerRows().filter((l) => l[3] === "failed_permanent")).toHaveLength(1);
    expect(tracking().filter((t) => t[21] === "review")).toHaveLength(1);
    clock = new Date(clock.getTime() + 48 * 3600_000);
    await runSendStep(sendDeps());
    expect(sendPosts()).toHaveLength(12); // 11 successes + the one rejected attempt: the rejected one is never retried
    expect(google.sentLog).toHaveLength(11);
  });

  it("timeout AFTER Gmail processed the send: reconciled against Gmail (metadata permission) -> recorded as sent once, never resent", async () => {
    // the members consented to the optional metadata permission, which reconciliation needs
    google.state.metadata = true;
    for (const m of MEMBERS) await connectGmail(m);
    google.state.sendScript = ["timeout-but-sent"];
    const r = await runSendStep(sendDeps());
    expect(r.reconciled).toBe(1);
    expect(r.sent).toBe(12);
    expect(google.sentLog).toHaveLength(12);
    expect(ledgerRows().filter((l) => l[3] === "sent")).toHaveLength(12);
    expect(ledgerRows().some((l) => /uncertain send result; reconciling.*confirmed by reconciliation/.test(l[21]))).toBe(true);
  });

  it("timeout where Gmail did NOT process the send: reconciled as not sent, retried later exactly once", async () => {
    google.state.metadata = true;
    for (const m of MEMBERS) await connectGmail(m);
    google.state.sendScript = ["timeout-not-sent"];
    const r = await runSendStep(sendDeps());
    expect(r.sent).toBe(11);
    expect(ledgerRows().filter((l) => l[3] === "failed_transient")).toHaveLength(1);
    clock = new Date(clock.getTime() + 20 * 60_000);
    expect((await runSendStep(sendDeps())).sent).toBe(1);
    expect(google.sentLog).toHaveLength(12);
  });

  it("timeout after Gmail processed the send, WITHOUT the metadata permission: cannot be proven -> manual review, never resent", async () => {
    google.state.sendScript = ["timeout-but-sent"];
    const r = await runSendStep(sendDeps());
    expect(r.needsReview).toBe(1);
    expect(tracking().filter((t) => t[21] === "uncertain")).toHaveLength(1);
    for (let i = 1; i <= 3; i++) {
      clock = new Date(clock.getTime() + i * 24 * 3600_000);
      await runSendStep(sendDeps());
    }
    expect(google.sentLog).toHaveLength(12); // 11 + the one Gmail did process; the uncertain one was never sent a second time
    expect(sendPosts().length).toBe(12);
  });

  it("an attachment that cannot be verified in the saved draft blocks the send and flags it for review", async () => {
    google.state.hideAttachmentOnRead = true;
    const r = await runSendStep(sendDeps());
    expect(r.sent).toBe(0);
    expect(google.sentLog).toHaveLength(0);
    expect(tracking().every((t) => t[21] === "review")).toBe(true);
  });

  it("a member whose Gmail is not connected sends nothing and is paused; the other members' e-mails still go out; no contact is reported complete", async () => {
    const r = await runSendStep(sendDeps({ gmail: { ...sendDeps().gmail, address: async (m) => (m === "lukky" ? null : `${m}@gmail.example`) } }));
    expect(r.sent).toBe(8);
    expect(google.sentLog.every((x) => x.mailbox !== "lukky")).toBe(true);
    expect(tracking().every((t) => t[21] === "pending" && /lukky: \[member_identity\]/.test(t[25]))).toBe(true);
  });

  it("a closed gate sends nothing even with all mocks wired", async () => {
    const r = await runSendStep(sendDeps({ gate: false }));
    expect(r.status).toBe("disabled");
    expect(sendPosts()).toHaveLength(0);
    // and the cycle itself, handed a closed gate, never calls the send step
    const out = await runOutreachCycle(cycle({ gate: false, send: async () => { throw new Error("must not be called"); } }));
    expect(out.send?.status).toBe("disabled");
    expect(out.errors).toEqual([]);
  });

  it("the cycle runs the send step only when the gate is open, then refreshes statuses and counters", async () => {
    const out = await runOutreachCycle(cycle({ gate: true, send: () => runSendStep(sendDeps()) }));
    expect(out.send).toMatchObject({ status: "ran", sent: 12 });
    expect(out.counters).toMatchObject({ sentToday: 12, emailsSent: 12 });
    expect(outreach.fake.dataRows("Outreach Daily Counters").at(-1)![11]).toBe("12");
    const again = await runOutreachCycle(cycle({ gate: true, send: () => runSendStep(sendDeps()) }));
    expect(again.send?.sent).toBe(0);
    expect(google.sentLog).toHaveLength(12);
  });

  describe("draft backlog protection in the full cycle (real Gmail adapters, mock Gmail server)", () => {
    // What the production send wrapper does: after sending, the cached backlog count is dropped so the drafting step recounts.
    const sendThenRecount = async () => {
      try {
        return await runSendStep(sendDeps());
      } finally {
        getDraftBacklogGate().invalidate();
      }
    };
    const NEWCO = { ...FORM, name: "Late Person", email: "late@newco.example", company: "NewCo", companyUrl: "https://newco.com" };
    const ledgerKeys = () => ledger().map((r) => r[0]);

    it("with 100+ pending drafts: sending keeps priority and sends EVERY eligible draft, new drafting is paused, and it resumes below 100", async () => {
      await seedPending(100); // 100 other unsent JobSync drafts in the members' Gmail, on top of the 12 real ones
      const lateConn = await add("anni", NEWCO); // a new manual Connection is waiting for its drafts
      getDraftBacklogGate().invalidate();
      const draftsBefore = google.drafts.length;

      const first = await runOutreachCycle(cycle({ gate: true, send: sendThenRecount }));
      expect(first.send).toMatchObject({ status: "ran", sent: 12 }); // all twelve eligible drafts (4 Connections x 3 members) went out in this one call
      expect(sendPosts()).toHaveLength(12);
      expect(first.drafts).toMatchObject({ created: 0, paused: expect.stringMatching(/drafting paused: 100 unsent drafts/) }); // 112 - 12 = 100: still at the limit
      expect(google.drafts).toHaveLength(draftsBefore); // no draft was created
      expect(ledgerKeys().some((k) => k.includes(lateConn.connectionId))).toBe(false); // and nothing was recorded for the waiting Connection

      // one more pending draft is gone from Gmail (sent by hand): 99 pending -> drafting resumes by itself on the next cron call
      google.sentDrafts.add(google.drafts.find((d) => !google.sentDrafts.has(d.id) && d.subject === "seed")!.id);
      getDraftBacklogGate().invalidate();
      const second = await runOutreachCycle(cycle({ gate: true, send: sendThenRecount }));
      expect(second.drafts).toMatchObject({ created: 3 });
      expect((second.drafts as { paused?: string }).paused).toBeUndefined();
      expect(ledgerKeys().filter((k) => k.includes(lateConn.connectionId))).toHaveLength(3); // all three members drafted for the late Connection
    });

    it("drafts that are not ready to send (flagged for review, e.g. no verified resume) stay untouched in Gmail while everything else drains", async () => {
      const row = [...(await readDraftLedger({ fresh: true })).values()].find((d) => d.memberId === "lukky")!;
      await recordDraft({ ...row, detail: "review: resume attachment could not be verified in the saved draft" });
      const r = await runSendStep(sendDeps());
      expect(r.sent).toBe(11);
      expect(google.sentDrafts.has(row.gmailDraftId)).toBe(false); // not sent...
      expect(google.drafts.some((d) => d.id === row.gmailDraftId)).toBe(true); // ...and still there, unchanged
      expect(google.urls.some((u) => /^(DELETE|PUT|PATCH) /.test(u) || /trash|modify/.test(u))).toBe(false); // never deleted, edited or trashed
      for (let i = 0; i < 3; i++) await runSendStep(sendDeps());
      expect(sendPosts()).toHaveLength(11); // every later call leaves it alone too
      expect((await readDraftLedger({ fresh: true })).get(row.draftKey)?.status).toBe("created");
      getDraftBacklogGate().invalidate();
      expect(await getDraftBacklogGate().check()).toMatchObject({ pending: 0 }); // needs a person: not part of the ELIGIBLE backlog...
      expect(getDraftBacklogGate().last()).toMatchObject({ parked: 1 }); // ...but counted and reported, never discarded
    });

    it("EVERY unsent JobSync draft is found however old (no creation-date cutoff): sent from its own mailbox with its own resume, with no new draft created", async () => {
      for (const r of sheets.dataRows("Connections")) r[10] = "2026-08-01T00:00:00.000Z"; // the Connections were created months ago
      invalidateTableCache();
      outreach = newOutreachSpreadsheet(masterGrid([])); // and nothing has ever tracked them
      getDraftBacklogGate().invalidate();
      const draftsBefore = google.drafts.length;
      const out = await runOutreachCycle(cycle({ gate: true, send: sendThenRecount }));
      expect(out.existing).toMatchObject({ adopted: 4, orphaned: 0 });
      expect(out.send).toMatchObject({ status: "ran", sent: 12 });
      expect(tracking().map((t) => t[2])).toEqual(Array(4).fill("existing-draft"));
      for (const x of google.sentLog) {
        const d = google.drafts.find((y) => y.id === x.draftId)!;
        expect(d.mailbox).toBe(x.mailbox); // sent from the member whose draft it is
        expect(d.files).toHaveLength(1);
        expect(d.files[0].name).toMatch(x.mailbox === "anni" ? /^Aniket/ : x.mailbox === "lukky" ? /^Lakshya/ : /^Rishi/); // that member's own resume
      }
      expect(google.drafts).toHaveLength(draftsBefore); // nothing was re-drafted
      expect(ledgerRows().every((l) => l[3] === "sent" && l[14].startsWith("msg-"))).toBe(true); // every send is in the durable ledger with Gmail's message id
      const again = await runOutreachCycle(cycle({ gate: true, send: sendThenRecount }));
      expect(again.send?.sent).toBe(0);
      expect(sendPosts()).toHaveLength(12); // never twice
    });

    it("an unsendable draft is parked through the real wiring: only the ledger note changes, the Gmail draft stays exactly as it is, and it leaves the eligible backlog", async () => {
      outreach.fake.tabs.set("Outreach Exclusions", [["Value", "Reason", "AddedAt", "AddedBy"], ["full@acme.example.com", "asked not to be contacted", "", "anni"]]);
      const cfg = loadOutreachConfig({ OUTREACH_ENABLED: "true", OUTREACH_SPREADSHEET_ID: "outreach-test" } as unknown as NodeJS.ProcessEnv);
      const r = await runSendStep(buildRealSendDeps(cfg, outreach.sheet, "Asia/Kolkata"));
      expect(r.sent).toBe(9); // the other three Connections; the opted-out recipient got nothing from any member
      expect(r.parkedChanges).toBe(3);
      const parked = ledger().filter((x) => x[7].includes("parked:"));
      expect(parked).toHaveLength(3);
      expect(parked.every((x) => x[5] === "created" && /opted out.*asked not to be contacted/.test(x[7]))).toBe(true);
      const stillThere = google.drafts.filter((d) => d.to === "full@acme.example.com");
      expect(stillThere).toHaveLength(3);
      expect(stillThere.every((d) => !google.sentDrafts.has(d.id))).toBe(true);
      expect(google.urls.some((u) => /^(DELETE|PUT|PATCH) /.test(u) || /trash|modify/.test(u))).toBe(false);
      getDraftBacklogGate().invalidate();
      expect(await getDraftBacklogGate().check()).toMatchObject({ allowed: true, pending: 0 });
      expect(getDraftBacklogGate().last()).toMatchObject({ parked: 3 });
      expect((await runSendStep(buildRealSendDeps(cfg, outreach.sheet, "Asia/Kolkata"))).parkedChanges).toBe(0); // recorded once, not rewritten every call
    });

    it("READ BUDGET: a send step for 12 e-mails makes no per-call token refresh, almost no Gmail-account or resume-file reads, and far fewer Sheets reads than before (~190)", async () => {
      const counts: Record<string, number> = {};
      const wrap = (fake: { getValues(r: string): Promise<string[][]> }, prefix: string) => {
        const orig = fake.getValues.bind(fake);
        fake.getValues = async (range: string) => { const k = prefix + range.split("!")[0].replace(/'/g, ""); counts[k] = (counts[k] ?? 0) + 1; return orig(range); };
      };
      wrap(sheets, "");
      wrap(outreach.fake, "OUTREACH:");
      google.urls.length = 0;
      const r = await runSendStep(sendDeps());
      expect(r.sent).toBe(12);
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      expect(google.urls.filter((u) => u.includes("oauth2.googleapis.com/token")).length).toBeLessThanOrEqual(3); // at most one per member (was 24)
      expect(counts["NF_GmailAccounts"] ?? 0).toBeLessThanOrEqual(6); // was 27
      expect(counts["ChatFiles"] ?? 0).toBeLessThanOrEqual(6); // resume bytes: was 24
      expect(total).toBeLessThanOrEqual(130); // was ~190 with the table cache switched off, as it is under test
    });

    it("a resume is downloaded once and reused for later checks, but a replaced file is always loaded afresh", async () => {
      const { existingResumes } = await import("@/lib/network-finder/gateways");
      const counts = { chat: 0 };
      const orig = sheets.getValues.bind(sheets);
      sheets.getValues = async (range: string) => { if (range.startsWith("ChatFiles")) counts.chat += 1; return orig(range); };
      const first = await existingResumes("anni", "Software Engineer");
      expect(first.status).toBe("attached");
      const afterFirst = counts.chat;
      const second = await existingResumes("anni", "Software Engineer");
      expect(counts.chat).toBe(afterFirst); // no further download
      expect(second.status === "attached" && first.status === "attached" && Buffer.from(second.attachment.bytes).equals(Buffer.from(first.attachment.bytes))).toBe(true);
      // the member replaces the file (delete + upload under the same name): the next check must see the NEW bytes
      const old = (await listResumes("anni"))!.find((x) => x.fileName === "Aniket_Raj_SDE.pdf")!;
      await deleteResume("anni", old.recordId);
      await addResume("anni", { bytes: pdfBytes("anni:replacement"), fileName: "Aniket_Raj_SDE.pdf", mimeType: "application/pdf" });
      const third = await existingResumes("anni", "Software Engineer");
      expect(third.status).toBe("attached");
      if (third.status === "attached" && first.status === "attached") expect(Buffer.from(third.attachment.bytes).equals(Buffer.from(first.attachment.bytes))).toBe(false);
      expect(counts.chat).toBeGreaterThan(afterFirst); // it was downloaded again
    });

    it("sending continues across subsequent cron calls, as time allows, until every eligible draft is drained", async () => {
      const slices: number[] = [];
      for (let call = 0; call < 6; call++) {
        const before = google.sentLog.length;
        const deps = sendDeps();
        // each call only has time for 5 sends: the time budget (not a count limit) ends it
        Object.defineProperty(deps, "deadline", { get: () => (google.sentLog.length - before >= 5 ? Date.now() - 1 : Date.now() + 60_000) });
        const r = await runSendStep(deps);
        slices.push(r.sent);
        if (r.sent === 0) break;
      }
      expect(slices).toEqual([5, 5, 2, 0]);
      expect(sendPosts()).toHaveLength(12); // each draft sent exactly once across all the calls
      expect(new Set(google.sentLog.map((x) => x.draftId)).size).toBe(12);
    });
  });
});

// ---- Draft backlog protection with the REAL Gmail adapters: drafts.list is paged, counted per member, and fails closed ----------------

/** n unsent JobSync-generated drafts spread over the three members: really in their (mock) Gmail Drafts folder AND recorded in the draft ledger. */
async function seedPending(n: number, detail = "") {
  for (let i = 0; i < n; i++) {
    const member = MEMBERS[i % 3];
    const id = `draft-${google.drafts.length + 1}`;
    google.drafts.push({ mailbox: member, id, subject: "seed", to: `seed${i}@seed.example`, body: "seed", raw: "", files: [] });
    await recordDraft({ draftKey: `contact:seed${i}:${member}`, memberId: member, itemType: "contact", itemId: `seed${i}`, gmailDraftId: id, status: "created", createdAt: new Date().toISOString(), detail });
  }
}

describe("draft backlog gate with the real Gmail adapters (mock Gmail server)", () => {
  const NEW = { ...FORM, name: "Pat Newman", email: "pat@newco.example", company: "NewCo", companyUrl: "https://newco.com" };
  const postsToDrafts = () => google.urls.filter((u) => u === "POST https://gmail.googleapis.com/gmail/v1/users/me/drafts");
  const listCalls = () => google.urls.filter((u) => u.startsWith("GET https://gmail.googleapis.com/gmail/v1/users/me/drafts?maxResults=500"));

  it("99 pending drafts in Gmail: new drafting proceeds (the whole three-member fan-out)", async () => {
    await seedPending(99);
    const c = await add("anni", NEW);
    const r = await work();
    expect(r).toMatchObject({ checked: 1, created: 3 });
    expect(r.paused).toBeUndefined();
    expect(postsToDrafts()).toHaveLength(3);
    expect(ledger().filter((x) => x[3] === c.connectionId && x[5] === "created")).toHaveLength(3);
  });

  it("100 pending drafts in Gmail: ALL new drafting pauses (nothing composed, no Gmail draft created, nothing recorded)", async () => {
    await seedPending(100);
    const c = await add("anni", NEW);
    const r = await work();
    expect(r).toMatchObject({ checked: 0, created: 0 });
    expect(r.paused).toMatch(/drafting paused: 100 unsent drafts are waiting/);
    expect(postsToDrafts()).toHaveLength(0);
    expect(ledger().filter((x) => x[3] === c.connectionId)).toHaveLength(0);
  });

  it("the count is of REAL Gmail drafts: ledger rows whose draft is gone from Gmail (sent or deleted) do not count", async () => {
    await seedPending(120);
    for (const d of google.drafts.slice(0, 30)) google.sentDrafts.add(d.id); // 30 were sent / deleted in Gmail: the ledger still says "created"
    await add("anni", NEW);
    const r = await work(); // 90 really pending
    expect(r).toMatchObject({ created: 3 });
  });

  it("drafts the members wrote by hand, however many, are not counted (only JobSync-generated drafts are)", async () => {
    await seedPending(10);
    google.state.handwritten = { anni: 1300, lukky: 700, rishii: 400 }; // 3 pages for anni: the list is paged, not truncated
    await add("anni", NEW);
    const r = await work();
    expect(r).toMatchObject({ created: 3 });
    expect(listCalls().length).toBeGreaterThanOrEqual(3 + 2 + 1); // anni 3 pages, lukky 2 pages, rishii 1 page (counted at least once)
  });

  it("a pending draft is found on a LATER page of a large Drafts folder (pagination is followed to the end)", async () => {
    google.state.handwritten = { anni: 1400, lukky: 0, rishii: 0 };
    await seedPending(100); // the JobSync drafts come after the 1,400 hand-written ones in listing order
    await add("anni", NEW);
    expect((await work()).paused).toMatch(/drafting paused: 100 unsent/);
  });

  it("FAIL CLOSED: if one member's Drafts folder cannot be listed, drafting pauses (and resumes as soon as Gmail answers again)", async () => {
    google.state.failList.add("lukky");
    const c = await add("anni", NEW);
    const r = await work();
    expect(r.paused).toMatch(/lukky's Gmail drafts could not be counted/);
    expect(postsToDrafts()).toHaveLength(0);
    expect(ledger().filter((x) => x[3] === c.connectionId)).toHaveLength(0);
    google.state.failList.clear();
    getDraftBacklogGate().invalidate(); // (a failed count is also retried by itself after a few seconds)
    expect(await work()).toMatchObject({ created: 3 });
  });

  it("FAIL CLOSED: a Drafts folder too large to count reliably pauses drafting instead of guessing", async () => {
    google.state.handwritten = { anni: 10_100, lukky: 0, rishii: 0 }; // more than 20 pages of 500
    await add("anni", NEW);
    const r = await work();
    expect(r.paused).toMatch(/too many drafts to count/);
    expect(postsToDrafts()).toHaveLength(0);
  });

  it("the count is per member: one Connection with three drafts is three pending drafts, tracked separately", async () => {
    await seedPending(6);
    const gate = getDraftBacklogGate();
    gate.invalidate();
    await gate.check();
    expect(gate.last()).toMatchObject({ status: "ok", pending: 6, byMember: { anni: 2, lukky: 2, rishii: 2 } });
  });

  it("both workers are gated: the Network Finder cron's draft step and the Outreach cycle's draft step share the rule", async () => {
    await seedPending(100);
    await add("anni", NEW);
    // the Network Finder cron calls runPendingDrafts(deps, { limit: 2 }); the Outreach cycle calls it with its own limit: same function, same gate
    expect((await runPendingDrafts(workerDeps(), { limit: 2 })).paused).toBeDefined();
    expect((await runPendingDrafts(workerDeps(), { limit: 10 })).paused).toBeDefined();
    expect(postsToDrafts()).toHaveLength(0);
  });
});
