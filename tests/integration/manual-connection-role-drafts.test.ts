/**
 * REGRESSION (31 Oct): manual connections kept getting the same generic "Software Engineer" email because the draft never
 * read the connection's description. These tests add connections the way members do (a name, a company, an email and a
 * description that holds the role), run the real worker against mock Google + the in-memory sheet, and read the drafts that
 * land in each member's own mailbox. Nothing real is contacted and nothing is sent.
 */
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/session")>()), getSession: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { POST as addConnection } from "@/app/api/connections/route";
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
import { runBatchTick, runPendingDrafts, type PipelineDeps } from "@/lib/network-finder/pipeline";
import { createSheetsStores } from "@/lib/network-finder/sheets-stores";
import type { Connection } from "@/types/domain";
import { FakeSheets } from "../helpers/fake-sheets";

let sheets: FakeSheets;
const MEMBERS = ["anni", "lukky", "rishii"] as const;
const FULL: Record<MemberId, string> = { anni: "Aniket Raj", lukky: "Lakshya Singh", rishii: "Rishi Raj" };
const LINKS: Record<MemberId, [string, string]> = {
  anni: ["https://www.linkedin.com/in/raj-aniket/", "https://github.com/iamankoo"],
  lukky: ["https://www.linkedin.com/in/lakshya-singh-243510302/", "https://github.com/lukkydiwan"],
  rishii: ["https://www.linkedin.com/in/rishi-raj-8bb5a8366/", "https://github.com/Rishi-Ra-1j4"],
};
const as = (m: MemberId | null) => vi.mocked(getSession).mockResolvedValue(m ? { memberId: m, expiresAt: 9_999_999_999 } : null);
const idToken = (email: string) => `h.${Buffer.from(JSON.stringify({ email, email_verified: true })).toString("base64url")}.s`;

interface Sent {
  mailbox: MemberId;
  subject: string;
  to: string;
  body: string;
}
function mockGoogle() {
  const drafts: Sent[] = [];
  const failMailbox = new Set<string>();
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
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
      drafts.push({ mailbox: who as MemberId, subject, to: header("To"), body: Buffer.from(b64.replace(/\r\n/g, ""), "base64").toString("utf8").replace(/\r\n/g, "\n").trimEnd() });
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
const post = async (m: MemberId, body: Record<string, unknown>) => {
  as(m);
  const res = await addConnection(new Request("http://localhost/api/connections", { method: "POST", headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify(body) }));
  expect(res.status).toBe(201);
  return (await res.json()).data as Connection;
};
const ledger = () => sheets.dataRows("NF_Drafts");
const status = async (id: string) => {
  as("rishii");
  return (await (await draftStatus(new Request(`http://localhost/api/connections/${id}/draft`), { params: Promise.resolve({ connectionId: id }) })).json()).data;
};

/** What the company's own site says (the real researcher reads it; here it is a fixed, synthetic answer). */
const SITES: Record<string, { website: string; description: string; jobs?: { title: string; description: string }[] }> = {
  "Magic Hour AI": { website: "https://magichour.example/", description: "Magic Hour is an AI video creation platform for generating and editing video with generative models.", jobs: [{ title: "Machine Learning Engineer, Video Generation", description: "Train and serve video diffusion models in Python and PyTorch." }] },
  Learnosphere: { website: "https://learnosphere.example/", description: "Learnosphere builds an online learning platform that helps students learn through interactive courses." },
  Alehar: { website: "https://alehar.example/", description: "Alehar is a technology company working on data and artificial intelligence products for businesses." },
  Ledgerly: { website: "https://ledgerly.example/", description: "Ledgerly provides payment and invoicing infrastructure for small businesses." },
  Pipewise: { website: "https://pipewise.example/", description: "Pipewise helps companies move and clean their data between warehouses and analytics tools." },
};
const research: CompanyResearcher = async ({ name }) => {
  const s = SITES[name];
  return s ? { website: s.website, description: s.description, jobs: (s.jobs ?? []).map((j) => ({ source: "Greenhouse", companyName: name, title: j.title, url: `${s.website}jobs/1`, description: j.description })) } : { jobs: [] };
};

function workerDeps(): PipelineDeps {
  const stores = createSheetsStores();
  return {
    config: loadNetworkFinderConfig({ NETWORK_FINDER_ENABLED: "true", APP_TIMEZONE: "Asia/Kolkata" } as unknown as NodeJS.ProcessEnv),
    sources: [], jobSources: [], research,
    queue: stores.queue, registry: stores.registry, ledger: stores.ledger, selections: stores.selections,
    drafts: existingDraftDeps(), connections: existingConnections, jobs: existingJobs, runState: {},
  };
}
const work = (options: Parameters<typeof runPendingDrafts>[1] = { limit: 10 }) => runPendingDrafts(workerDeps(), options);

beforeEach(async () => {
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
  for (const m of MEMBERS) await connectGmail(m);
  google.drafts.length = 0;
});
afterEach(() => {
  setSheetsClientForTesting(null);
  vi.mocked(getSession).mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const CASES = [
  { company: "Magic Hour AI", person: "Priya Nair", email: "priya@magichour.example", notes: "Hiring for Machine Learning Engineer – Video Generation.", role: "Machine Learning Engineer", focus: "Video Generation" },
  { company: "Learnosphere", person: "Dev Malhotra", email: "dev@learnosphere.example", notes: "Role: Full Stack Developer Intern", role: "Full Stack Developer Intern" },
  { company: "Alehar", person: "Sana Iqbal", email: "sana@alehar.example", notes: "Technology, Data & AI Internship", role: "Technology, Data & AI Internship" },
  { company: "Ledgerly", person: "Tom Becker", email: "tom@ledgerly.example", notes: "Role: Backend Engineer (Payments)", role: "Backend Engineer", focus: "Payments" },
  { company: "Pipewise", person: "Neha Rao", email: "neha@pipewise.example", notes: "Role: Data Engineer", role: "Data Engineer" },
] as const;

describe("role-specific drafts for manually added connections", () => {
  it("five different roles → five different, correctly named emails in each member's own Gmail, none of them a generic Software Engineer email", async () => {
    const added: Connection[] = [];
    for (const c of CASES) added.push(await post("lukky", { name: c.person, company: c.company, role: "Engineering Manager", email: c.email, notes: c.notes }));
    expect(google.drafts).toHaveLength(0); // saving never waits for Gmail

    await work();
    expect(google.drafts).toHaveLength(15);

    for (const c of CASES) {
      const mine = google.drafts.filter((d) => d.to === c.email);
      expect(mine.map((d) => d.mailbox).sort()).toEqual(["anni", "lukky", "rishii"]);
      for (const d of mine) {
        const m = d.mailbox;
        // exact role, company, recipient
        expect(d.subject).toBe(`Application for ${c.role.replace(/ Intern$/, " Internship")} — ${c.company}`); // the subject spells a trailing "Intern" as "Internship"
        expect(d.body.startsWith(`Dear ${c.person.split(" ")[0]},`)).toBe(true);
        expect(d.body).toContain(c.company);
        expect(d.body).toContain(c.role);
        if ("focus" in c) expect(d.body).toContain(c.focus);
        // never the generic role the old drafts defaulted to
        expect(d.body).not.toMatch(/Software Engineer/i);
        expect(d.subject).not.toMatch(/Software Engineer/i);
        // the person's designation is not mistaken for the role
        expect(d.body).not.toContain("Engineering Manager");
        // company-specific content: the company's own words
        expect(d.body).toContain(SITES[c.company].description.split(".")[0].slice(0, 30));
        // this member's own name and links, and nobody else's
        expect(d.body.endsWith(`Best regards,\n${FULL[m]}\nLinkedIn: ${LINKS[m][0]}\nGitHub: ${LINKS[m][1]}`)).toBe(true);
        for (const o of MEMBERS.filter((x) => x !== m)) {
          expect(d.body).not.toContain(FULL[o]);
          expect(d.body).not.toContain(LINKS[o][0]);
          expect(d.body).not.toContain(LINKS[o][1]);
        }
      }
      // each member's email is written from their own profile, never copied
      const bodies = mine.map((d) => d.body.split("\n\nBest regards,")[0].replace(/^Dear [^\n]+\n\n/, ""));
      expect(new Set(bodies).size).toBe(3);
    }

    // different roles → different emails for the same member (not one reused template)
    for (const m of MEMBERS) {
      const own = google.drafts.filter((d) => d.mailbox === m);
      expect(new Set(own.map((d) => d.subject)).size).toBe(5);
      expect(new Set(own.map((d) => d.body.split("\n\nBest regards,")[0].replace(/^Dear [^\n]+\n\n/, ""))).size).toBe(5);
    }

    // role-specific emphasis from VERIFIED skills only
    const find = (company: string, m: MemberId) => google.drafts.find((d) => d.mailbox === m && d.body.includes(company) && d.to.includes(company.split(" ")[0].toLowerCase()))!;
    expect(find("Pipewise", "anni").body).toMatch(/Python|SQL|pipelines/);
    expect(find("Learnosphere", "lukky").body).toMatch(/MERN|React/);
    expect(find("Magic Hour AI", "anni").body).toMatch(/AI|computer vision|LLM|Python/);

    // all three mailboxes are recorded per connection, with the individual status visible
    for (const c of added) {
      expect(ledger().filter((r) => r[3] === c.connectionId).map((r) => r[5])).toEqual(["created", "created", "created"]);
      const s = await status(c.connectionId);
      expect(s.state).toBe("drafted");
      expect(s.members.map((m: { status: string }) => m.status)).toEqual(["created", "created", "created"]);
    }
  });

  it("a member with no verified profile gets a role-specific email that claims no skills, projects or education", async () => {
    await post("anni", { name: "Priya Nair", company: "Magic Hour AI", email: "priya@magichour.example", notes: "Hiring for Machine Learning Engineer – Video Generation." });
    await work();
    const rishi = google.drafts.find((d) => d.mailbox === "rishii")!;
    expect(rishi.subject).toBe("Application for Machine Learning Engineer — Magic Hour AI");
    expect(rishi.body).toContain("Machine Learning Engineer");
    expect(rishi.body).toContain("Video Generation");
    expect(rishi.body).not.toMatch(/\b(React|Node\.js|Python|MongoDB|JavaScript|RAG|LLM|IIIT|intern at|Flutter|Docker)\b/i);
    expect(rishi.body).not.toMatch(/final-year|B\.Tech|student/i);
    // the other two do state their verified background
    expect(google.drafts.find((d) => d.mailbox === "anni")!.body).toMatch(/IIIT Manipur/);
    expect(google.drafts.find((d) => d.mailbox === "lukky")!.body).toMatch(/final-year Computer Science/);
    expect(google.drafts.find((d) => d.mailbox === "lukky")!.body).not.toMatch(/IIIT|Flutter|Docker|Next\.js/);
  });

  it("no role in the description → a neutral enquiry (never a default Software Engineer), flagged for review in the ledger", async () => {
    const c = await post("anni", { name: "Meera Shah", company: "Ledgerly", role: "Recruiter", email: "meera@ledgerly.example", notes: "Met at the campus fair, very friendly." });
    await work();
    expect(google.drafts).toHaveLength(3);
    for (const d of google.drafts) {
      expect(d.subject).toBe("Enquiry about opportunities at Ledgerly");
      expect(d.body).toContain("which roles or internships are currently open");
      expect(d.body).not.toMatch(/Software Engineer|Backend|Full Stack|Data Engineer|Machine Learning/i);
      expect(d.body).not.toMatch(/\b(React|Python|Node\.js)\b/);
      expect(d.body.endsWith(`Best regards,\n${FULL[d.mailbox]}\nLinkedIn: ${LINKS[d.mailbox][0]}\nGitHub: ${LINKS[d.mailbox][1]}`)).toBe(true);
    }
    expect(ledger().filter((r) => r[3] === c.connectionId).every((r) => r[7].startsWith("review: no role found"))).toBe(true);
  });

  it("two different roles in the description are ambiguous → neutral enquiry, not a guess", async () => {
    await post("anni", { name: "Meera Shah", company: "Ledgerly", email: "meera@ledgerly.example", notes: "Role: Backend Engineer or Data Engineer" });
    await work();
    expect(google.drafts.every((d) => d.subject === "Enquiry about opportunities at Ledgerly")).toBe(true);
    expect(ledger().every((r) => /review: several roles/.test(r[7]))).toBe(true);
  });
});

describe("duplicates, retries and a disconnected mailbox", () => {
  it("a created draft is never recreated: running the worker again adds nothing", async () => {
    await post("lukky", { name: "Dev Malhotra", company: "Learnosphere", email: "dev@learnosphere.example", notes: "Role: Full Stack Developer Intern" });
    await work();
    expect(google.drafts).toHaveLength(3);
    expect(await work()).toMatchObject({ checked: 0, created: 0 });
    expect(google.drafts).toHaveLength(3);
    expect(ledger()).toHaveLength(3);
  });

  it("a failed mailbox is retried on its own; the other two are not drafted twice", async () => {
    const c = await post("lukky", { name: "Dev Malhotra", company: "Learnosphere", email: "dev@learnosphere.example", notes: "Role: Full Stack Developer Intern" });
    google.failMailbox.add("lukky");
    await work();
    expect(google.drafts.map((d) => d.mailbox).sort()).toEqual(["anni", "rishii"]);
    expect(ledger().filter((r) => r[3] === c.connectionId).map((r) => `${r[1]}:${r[5]}`).sort()).toEqual(["anni:created", "lukky:failed", "rishii:created"]);
    expect((await status(c.connectionId)).state).toBe("drafting");

    google.failMailbox.clear();
    await work();
    expect(google.drafts.map((d) => d.mailbox).sort()).toEqual(["anni", "lukky", "rishii"]); // only Lakshya's was added
    expect(ledger().filter((r) => r[3] === c.connectionId).map((r) => r[5])).toEqual(["created", "created", "created"]);
    expect((await status(c.connectionId)).state).toBe("drafted");
  });

  it("a connection that keeps failing does not block the ones behind it", async () => {
    await post("lukky", { name: "Broken Co", company: "Learnosphere", email: "dev@learnosphere.example", notes: "Role: Full Stack Developer Intern" });
    google.failMailbox.add("anni");
    await work({ limit: 1 });
    const second = await post("lukky", { name: "Neha Rao", company: "Pipewise", email: "neha@pipewise.example", notes: "Role: Data Engineer" });
    google.failMailbox.clear();
    await work({ limit: 1 });
    // the never-tried connection goes first, ahead of the one whose last attempt failed
    expect(ledger().filter((r) => r[3] === second.connectionId && r[5] === "created")).toHaveLength(3);
  });

  it("a disconnected Gmail is recorded once and does not block the other two accounts", async () => {
    // Rishi never connected: start a fresh sheet where only Anni and Lakshya did
    setSheetsClientForTesting(null);
    sheets = new FakeSheets().seedMembers();
    setSheetsClientForTesting(sheets);
    invalidateTableCache();
    resetMembersCache();
    await connectGmail("anni");
    await connectGmail("lukky");
    google.drafts.length = 0;
    const c = await post("anni", { name: "Neha Rao", company: "Pipewise", email: "neha@pipewise.example", notes: "Role: Data Engineer" });
    await work();
    expect(google.drafts.map((d) => d.mailbox).sort()).toEqual(["anni", "lukky"]);
    const s = await status(c.connectionId);
    expect(s.members.map((m: { memberId: string; status: string }) => `${m.memberId}:${m.status}`)).toEqual(["anni:created", "lukky:created", "rishii:skipped_unauthorized"]);
    expect(s.state).toBe("drafted");
    await work();
    expect(google.drafts).toHaveLength(2); // nothing repeated while Rishi stays disconnected
  });
});

describe("Network Finder no longer discovers connections", () => {
  it("the batch step does nothing (no sources run, no connection is created) while manual drafting still works", async () => {
    let discoverCalls = 0;
    const deps = workerDeps();
    deps.sources = [{ id: "hn", discover: async () => (discoverCalls++, { companies: [], nextCursor: undefined }) } as never];
    const before = (await existingConnections.list()).length;
    const tick = await runBatchTick(deps);
    expect(tick).toEqual({ ran: false, reason: "discovery_off" });
    expect(discoverCalls).toBe(0);
    expect((await existingConnections.list()).length).toBe(before);

    await post("lukky", { name: "Dev Malhotra", company: "Learnosphere", email: "dev@learnosphere.example", notes: "Role: Full Stack Developer Intern" });
    expect(await runPendingDrafts(deps, { limit: 2 })).toMatchObject({ created: 3 });
  });
});
