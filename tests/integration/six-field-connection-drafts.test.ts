/**
 * Six-field Add form -> company research -> three independent Gmail drafts (mock Google + in-memory sheet). Nothing real is
 * contacted, nothing is sent, no resume is attached.
 */
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDraftBacklogGate } from "@/lib/gmail/draft-backlog";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/session")>()), getSession: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { POST as addConnection } from "@/app/api/connections/route";
import { createConnection } from "@/lib/google-sheets/connections-service";
import { createConnectionSchema } from "@/lib/validation/connections";
import { GET as draftStatus } from "@/app/api/connections/[connectionId]/draft/route";
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

interface Sent {
  mailbox: MemberId;
  subject: string;
  to: string;
  body: string;
  raw: string;
}
function mockGoogle() {
  const drafts: Sent[] = [];
  const failMailbox = new Set<string>();
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    // drafts.list (read-only; what the draft-backlog gate counts): the ids of the drafts really in this mailbox. Not recorded as a call.
    if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/drafts?") && (init?.method ?? "GET") === "GET") {
      const who = (init?.headers as Record<string, string>).Authorization.replace("Bearer access-", "");
      return Response.json({ drafts: drafts.map((d, i) => ({ d, i })).filter(({ d }) => d.mailbox === who).map(({ i }) => ({ id: `draft-${i + 1}` })) });
    }
    if (url === "https://oauth2.googleapis.com/token") {
      const p = new URLSearchParams(String(init?.body));
      if (p.get("grant_type") === "authorization_code") {
        const who = p.get("code")!.replace("code-for-", "");
        return Response.json({ access_token: `access-${who}`, refresh_token: `refresh-${who}`, scope: `openid email ${GMAIL_COMPOSE_SCOPE}`, id_token: idToken(`${who}@gmail.example`) });
      }
      return Response.json({ access_token: p.get("refresh_token")!.replace("refresh-", "access-") });
    }
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/drafts") {
      const who = (init?.headers as Record<string, string>).Authorization.replace("Bearer access-", "");
      if (failMailbox.has(who)) return new Response("boom", { status: 500 });
      const text = Buffer.from(JSON.parse(String(init?.body)).message.raw, "base64url").toString("utf8");
      const [head, b64] = text.split("\r\n\r\n");
      const header = (n: string) => new RegExp(`^${n}: (.*)$`, "mi").exec(head)?.[1]?.trim() ?? "";
      const subjectRaw = header("Subject");
      const subject = /^=\?UTF-8\?B\?(.+)\?=$/i.test(subjectRaw) ? Buffer.from(subjectRaw.replace(/^=\?UTF-8\?B\?|\?=$/gi, ""), "base64").toString("utf8") : subjectRaw;
      drafts.push({ mailbox: who as MemberId, raw: text, subject, to: header("To"), body: Buffer.from(b64.replace(/\r\n/g, ""), "base64").toString("utf8").replace(/\r\n/g, "\n").trimEnd() });
      return Response.json({ id: `draft-${drafts.length}`, message: { threadId: `thread-${drafts.length}` } });
    }
    throw new Error(`unexpected request ${url}`);
  });
  return { fn, drafts, failMailbox };
}
let google: ReturnType<typeof mockGoogle>;

async function connectGmail(m: MemberId) {
  as(m);
  const start = await connect(new NextRequest("http://localhost:3000/api/gmail/connect"));
  const nonce = start.cookies.get("jobsync_gmail_oauth")!.value;
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  await callback(new NextRequest(`http://localhost:3000/api/gmail/callback?code=code-for-${m}&state=${encodeURIComponent(state)}`, { headers: { cookie: `jobsync_gmail_oauth=${nonce}` } }));
}

import { updateConnection } from "@/lib/google-sheets/connections-service";
import type { ResearchPage } from "@/lib/network-finder/company-research";

const ledger = () => sheets.dataRows("NF_Drafts");
const status = async (id: string) => {
  as("rishii");
  return (await (await draftStatus(new Request(`http://localhost/api/connections/${id}/draft`), { params: Promise.resolve({ connectionId: id }) })).json()).data;
};
/** A HISTORICAL record (no Role to Apply): the permissive service path. */
const post = async (m: MemberId, body: Record<string, unknown>) => {
  as(m);
  return createConnection(m, createConnectionSchema.parse(body));
};

/** The six-field Add form, exactly as the browser sends it. */
const add = async (m: MemberId, body: Record<string, unknown>) => {
  as(m);
  const res = await addConnection(new Request("http://localhost/api/connections", { method: "POST", headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify(body) }));
  expect(res.status).toBe(201);
  return (await res.json()).data as Connection;
};
const FORM = { name: "Priya Nair", role: "Engineering Manager", email: "priya@magichour.example", company: "Magic Hour AI", companyUrl: "https://magichour.ai", roleCategory: "AI/ML", applyRole: "Machine Learning Engineer" };

const SITE = {
  website: "https://magichour.ai/",
  description: "Magic Hour is an AI video creation platform for generating and editing video with generative models.",
  pages: [
    { kind: "home", url: "https://magichour.ai/", title: "Magic Hour", summary: "Magic Hour is an AI video creation platform for generating and editing video with generative models." },
    { kind: "about", url: "https://magichour.ai/about", title: "About", summary: "We build creative tools for video makers." },
  ] as ResearchPage[],
};
interface Call { name: string; website?: string }
let calls: Call[];
let researchMode: "ok" | "failed";
const research: CompanyResearcher = async ({ name, website }) => {
  calls.push({ name, ...(website ? { website } : {}) });
  if (researchMode === "failed") return { jobs: [], status: "unavailable", ...(website ? { website } : {}) };
  return { ...SITE, jobs: [], status: "verified", facts: ["We build creative tools for video makers."] };
};

function workerDeps(): PipelineDeps {
  const stores = createSheetsStores();
  return {
    config: loadNetworkFinderConfig({ DRAFT_DELAY_MINUTES: "0", NETWORK_FINDER_ENABLED: "true", APP_TIMEZONE: "Asia/Kolkata" } as unknown as NodeJS.ProcessEnv),
    sources: [], jobSources: [], research,
    queue: stores.queue, registry: stores.registry, ledger: stores.ledger, selections: stores.selections,
    drafts: existingDraftDeps(), connections: existingConnections, jobs: existingJobs, runState: {},
  };
}
const work = () => runPendingDrafts(workerDeps(), { limit: 10 });

beforeEach(async () => {
  calls = [];
  researchMode = "ok";
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
  invalidateTableCache();
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-client.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "test-client-secret");
  vi.stubEnv("GOOGLE_OAUTH_REDIRECT_URI", "http://localhost:3000/api/gmail/callback");
  vi.stubEnv("GMAIL_TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("NEMOTRON_API_KEY", ""); // the built-in writer: the deterministic, validated fill
  google = mockGoogle();
  vi.stubGlobal("fetch", google.fn);
  getDraftBacklogGate().invalidate(); // the process-wide backlog gate caches its count: start every test fresh
  for (const m of MEMBERS) await connectGmail(m);
  google.drafts.length = 0;
  google.fn.mockClear();
});
afterEach(() => {
  setSheetsClientForTesting(null);
  vi.mocked(getSession).mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("six-field connection → researched, role-specific drafts in three mailboxes (mock Gmail, in-memory sheet)", () => {
  it("creates one draft in each member's own mailbox, all for the selected Role to Apply, and sends nothing", async () => {
    const c = await add("lukky", FORM);
    expect(c).toMatchObject({ companyUrl: "https://magichour.ai/", roleCategory: "AI/ML", applyRole: "Machine Learning Engineer", role: "Engineering Manager" });
    expect(await work()).toMatchObject({ checked: 1, created: 3 });
    expect(google.drafts.map((d) => d.mailbox).sort()).toEqual(["anni", "lukky", "rishii"]);
    for (const d of google.drafts) {
      expect(d.to).toBe("priya@magichour.example");
      expect(d.subject).toBe("Application for Machine Learning Engineer — Magic Hour AI");
      expect(d.body).toContain("Machine Learning Engineer");
      expect(d.body.endsWith(`Best regards,\n${FULL[d.mailbox]}\nLinkedIn: ${LINKS[d.mailbox][0]}\nGitHub: ${LINKS[d.mailbox][1]}`)).toBe(true);
      // company-specific content comes from the researched (verified) description
      expect(d.body).toMatch(/AI video creation platform/);
    }
    expect(ledger().filter((r) => r[3] === c.connectionId).map((r) => r[5])).toEqual(["created", "created", "created"]);
    // Drafts only: the only Gmail call is drafts.create (no send endpoint was ever requested).
    const allGmail = google.fn.mock.calls.filter((a) => String(a[0]).includes("gmail.googleapis.com"));
    // The draft-backlog gate also lists each member's Drafts folder (read-only GET drafts.list); those are the only other Gmail calls.
    const lists = allGmail.filter((a) => String(a[0]).includes("/users/me/drafts?"));
    expect(lists.every((a) => ((a[1] as RequestInit | undefined)?.method ?? "GET") === "GET")).toBe(true);
    const gmailCalls = allGmail.filter((a) => !lists.includes(a)).map((a) => String(a[0]));
    expect(gmailCalls.length).toBe(3);
    expect(gmailCalls.every((u) => u.endsWith("/users/me/drafts"))).toBe(true);
  });

  it("attaches no resume: the message is single-part text with no attachment", async () => {
    await add("anni", FORM);
    await work();
    for (const d of google.drafts) {
      expect(d.raw).not.toMatch(/multipart\//i);
      expect(d.raw).not.toMatch(/Content-Disposition:\s*attachment/i);
      expect(d.raw).not.toMatch(/\.pdf/i);
    }
  });

  it("each draft is written from that member's OWN profile; an empty profile makes no claims", async () => {
    await add("anni", FORM);
    await work();
    const by = Object.fromEntries(google.drafts.map((d) => [d.mailbox, d.body]));
    expect(by.anni).toMatch(/IIIT Manipur/);
    expect(by.lukky).toMatch(/final-year Computer Science/);
    expect(by.lukky).not.toMatch(/IIIT|Flutter|Docker|Next\.js/);
    expect(by.rishii).not.toMatch(/\b(React|Node\.js|Python|MongoDB|JavaScript|RAG|LLM|IIIT|Flutter|Docker)\b/i);
    expect(by.rishii).not.toMatch(/final-year|B\.Tech|student/i);
    // never another member's links
    for (const m of MEMBERS) for (const o of MEMBERS.filter((x) => x !== m)) expect(by[m]).not.toContain(LINKS[o][0]);
    expect(new Set(Object.values(by)).size).toBe(3);
  });

  it("starts research from the Company URL and researches the company ONCE for the three drafts", async () => {
    await add("rishii", FORM);
    await work();
    expect(calls).toEqual([{ name: "Magic Hour AI", website: "https://magichour.ai/" }]);
  });

  it("the selected role is authoritative: free-text notes on the record do not override it", async () => {
    const c = await post("anni", { ...FORM, notes: "Role: Data Engineer", roleCategory: "SDE", applyRole: "Backend Engineer" });
    await work();
    expect(google.drafts).toHaveLength(3);
    for (const d of google.drafts) {
      expect(d.subject).toBe("Application for Backend Engineer — Magic Hour AI");
      expect(d.body).not.toMatch(/Data Engineer/);
    }
    expect(c.applyRole).toBe("Backend Engineer");
  });

  it("an 'Other' custom role is used word for word", async () => {
    await add("anni", { ...FORM, roleCategory: "Other", applyRole: "Site Reliability Engineer" });
    await work();
    for (const d of google.drafts) expect(d.subject).toBe("Application for Site Reliability Engineer — Magic Hour AI");
  });

  it("records the pages the company facts came from (provenance) with each draft", async () => {
    const c = await add("anni", FORM);
    await work();
    for (const r of ledger().filter((x) => x[3] === c.connectionId)) expect(r[7]).toContain("sources: https://magichour.ai/ https://magichour.ai/about");
  });

  it("failed research is reported honestly: drafts are still created, flagged, and state no company facts", async () => {
    researchMode = "failed";
    const c = await add("anni", FORM);
    await work();
    expect(google.drafts).toHaveLength(3);
    for (const r of ledger().filter((x) => x[3] === c.connectionId)) expect(r[7]).toMatch(/^review: company research unavailable/);
    for (const d of google.drafts) {
      expect(d.body).not.toMatch(/AI video creation platform|creative tools/);
      expect(d.body).not.toMatch(/Your website describes/);
    }
  });

  it("no Company URL: the existing research path is used (no URL is invented)", async () => {
    await add("anni", { ...FORM, companyUrl: "" });
    await work();
    expect(calls).toEqual([{ name: "Magic Hour AI" }]);
  });

  it("retries, repeated worker runs and page refreshes never create a second set of drafts", async () => {
    const c = await add("anni", FORM);
    await work();
    expect(google.drafts).toHaveLength(3);
    expect(await work()).toMatchObject({ checked: 0, created: 0 });
    expect(await status(c.connectionId)).toMatchObject({ state: "drafted", drafted: 3 });
    expect(google.drafts).toHaveLength(3);
    expect(ledger()).toHaveLength(3);
  });

  it("editing the connection afterwards (new URL / role) does not rewrite or duplicate the existing drafts", async () => {
    const c = await add("anni", FORM);
    await work();
    const before = google.drafts.map((d) => d.body);
    as("anni");
    await updateConnection("anni", c.connectionId, { companyUrl: "https://magichour.ai/new", roleCategory: "Data", applyRole: "Data Engineer" } as never);
    await work();
    expect(google.drafts.map((d) => d.body)).toEqual(before);
    expect(ledger()).toHaveLength(3);
  });

  it("a failing mailbox is named and the other two still succeed; the retry fills only the missing one", async () => {
    google.failMailbox.add("lukky");
    const c = await add("anni", FORM);
    await work();
    expect(google.drafts.map((d) => d.mailbox).sort()).toEqual(["anni", "rishii"]);
    const s = await status(c.connectionId);
    expect(s.members.map((m: { memberId: string; status: string }) => `${m.memberId}:${m.status}`)).toEqual(["anni:created", "lukky:failed", "rishii:created"]);
    google.failMailbox.clear();
    await work();
    expect(google.drafts.map((d) => d.mailbox).sort()).toEqual(["anni", "lukky", "rishii"]);
  });

  it("a historical connection (no Role to Apply, role in its notes) still drafts exactly as before", async () => {
    await post("anni", { name: "Neha Rao", company: "Magic Hour AI", email: "neha@magichour.example", notes: "Role: Data Engineer" });
    await work();
    expect(google.drafts).toHaveLength(3);
    for (const d of google.drafts) expect(d.subject).toBe("Application for Data Engineer — Magic Hour AI");
  });
});
