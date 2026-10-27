/**
 * Automatic drafting of EVERY new connection (manual or Network Finder) into all three members' own Gmail by the
 * scheduled worker — one ledger record per connection + mailbox, never sent. Google is a MOCK fetch; the session
 * is mocked; the spreadsheet is in memory. Nothing real is contacted.
 */
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/session")>()), getSession: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { POST as addConnection } from "@/app/api/connections/route";
import { PUT as editConnection } from "@/app/api/connections/[connectionId]/route";
import { GET as draftStatus } from "@/app/api/connections/[connectionId]/draft/route";
import { GET as connect } from "@/app/api/gmail/connect/route";
import { GET as callback } from "@/app/api/gmail/callback/route";
import type { MemberId } from "@/config/members";
import { draftListFor } from "@/lib/gmail/draft-list";
import { GMAIL_COMPOSE_SCOPE } from "@/lib/gmail/config";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { invalidateTableCache } from "@/lib/google-sheets/table";
import { loadNetworkFinderConfig } from "@/lib/network-finder/config";
import { existingConnections, existingDraftDeps, existingJobs } from "@/lib/network-finder/gateways";
import { runPendingDrafts, type PipelineDeps } from "@/lib/network-finder/pipeline";
import { runScheduledCycle } from "@/lib/network-finder/run";
import { createSheetsStores } from "@/lib/network-finder/sheets-stores";
import type { Connection } from "@/types/domain";
import { FakeSheets } from "../helpers/fake-sheets";

let sheets: FakeSheets;
const MEMBERS = ["anni", "lukky", "rishii"] as const;
const FULL: Record<MemberId, string> = { anni: "Aniket Raj", lukky: "Lakshya Singh", rishii: "Rishi Raj" };
const as = (m: MemberId | null) => vi.mocked(getSession).mockResolvedValue(m ? { memberId: m, expiresAt: 9_999_999_999 } : null);
const idToken = (email: string) => `h.${Buffer.from(JSON.stringify({ email, email_verified: true })).toString("base64url")}.s`;

/** Fake Google: per-member tokens; records every draft per access token (= per mailbox). */
function mockGoogle() {
  const drafts: { mailbox: string; raw: string }[] = [];
  const calls: string[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url.split("?")[0]);
    if (url === "https://oauth2.googleapis.com/token") {
      const p = new URLSearchParams(String(init?.body));
      if (p.get("grant_type") === "authorization_code") {
        const who = p.get("code")!.replace("code-for-", "");
        return Response.json({ access_token: `access-${who}`, refresh_token: `refresh-${who}`, scope: `openid email ${GMAIL_COMPOSE_SCOPE}`, id_token: idToken(`${who}@gmail.example`) });
      }
      return Response.json({ access_token: p.get("refresh_token")!.replace("refresh-", "access-") });
    }
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/drafts") {
      const auth = (init?.headers as Record<string, string>).Authorization.replace("Bearer access-", "");
      drafts.push({ mailbox: auth, raw: JSON.parse(String(init?.body)).message.raw });
      return Response.json({ id: `draft-${drafts.length}`, message: { threadId: `thread-${drafts.length}` } });
    }
    throw new Error(`unexpected request ${url}`);
  });
  return { fn, drafts, calls };
}
let google: ReturnType<typeof mockGoogle>;
const decode = (raw: string) => {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const [head, b64] = text.split("\r\n\r\n");
  // Email bodies use CRLF line endings; normalise them for the assertions.
  return { head, body: Buffer.from(b64.replace(/\r\n/g, ""), "base64").toString("utf8").replace(/\r\n/g, "\n").trimEnd() };
};

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
const recordsFor = (id: string) => ledger().filter((r) => r[3] === id).map((r) => [r[1], r[5]]).sort();
const mailboxes = () => google.drafts.map((d) => d.mailbox).sort();
const status = async (id: string) => {
  as("rishii"); // any signed-in member may see a connection's drafting state
  return (await (await draftStatus(new Request(`http://localhost/api/connections/${id}/draft`), { params: Promise.resolve({ connectionId: id }) })).json()).data;
};

/** The worker's dependencies, exactly as production wires the draft step (real gateways, ledger and stores). */
function workerDeps(): PipelineDeps {
  const stores = createSheetsStores();
  return {
    config: loadNetworkFinderConfig({ NETWORK_FINDER_ENABLED: "true", APP_TIMEZONE: "Asia/Kolkata" } as unknown as NodeJS.ProcessEnv),
    sources: [], jobSources: [],
    queue: stores.queue, registry: stores.registry, ledger: stores.ledger, selections: stores.selections,
    drafts: existingDraftDeps(), connections: existingConnections, jobs: existingJobs, runState: {},
  };
}
const work = (options: Parameters<typeof runPendingDrafts>[1] = {}) => runPendingDrafts(workerDeps(), options);

beforeEach(async () => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
  invalidateTableCache();
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-client.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "test-client-secret");
  vi.stubEnv("GOOGLE_OAUTH_REDIRECT_URI", "http://localhost:3000/api/gmail/callback");
  vi.stubEnv("GMAIL_TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("NEMOTRON_API_KEY", ""); // built-in writer (Nemotron is covered by its own tests)
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

describe("new manual connection → drafts in all three mailboxes (automatic)", () => {
  it("saving does not draft; the worker then drafts it into Anni's, Lukky's and Rishii's OWN Gmail, each signed with their full name", async () => {
    const c = await post("lukky", { name: "Adam Test", company: "Evidence", role: "CEO", email: "adam@evidence.example" });
    expect(google.drafts).toHaveLength(0); // the save never waits for Gmail/Nemotron
    expect((await status(c.connectionId)).state).toBe("waiting");

    expect(await work()).toMatchObject({ checked: 1, created: 3, remaining: 0 });
    expect(mailboxes()).toEqual(["anni", "lukky", "rishii"]);
    for (const d of google.drafts) {
      const m = d.mailbox as MemberId;
      const { head, body } = decode(d.raw);
      expect(head).toContain("To: adam@evidence.example");
      expect(head).not.toMatch(/^From:/m); // each draft is in that member's own account; no impersonation
      expect(body.endsWith(`Best regards,\n${FULL[m]}`)).toBe(true);
      for (const other of Object.values(FULL).filter((n) => n !== FULL[m])) expect(body).not.toContain(other);
    }
    expect(recordsFor(c.connectionId)).toEqual([["anni", "created"], ["lukky", "created"], ["rishii", "created"]]);
    expect(google.calls.some((u) => /send/.test(u))).toBe(false); // never sent

    expect(await status(c.connectionId)).toMatchObject({ state: "drafted", drafted: 3, sent: 0, skipped: 0, total: 3 });
    for (const m of MEMBERS) expect(await draftListFor(m)).toMatchObject({ drafted: 1, sent: 0, items: [expect.objectContaining({ person: "Adam Test", company: "Evidence", designation: "CEO", status: "Drafted" })] });
  });

  it("no email → never drafted, no records, state 'no_email'", async () => {
    const c = await post("anni", { name: "No Email", company: "Acme" });
    expect(await work()).toEqual({ checked: 0, created: 0, remaining: 0 });
    expect(google.drafts).toHaveLength(0);
    expect(ledger()).toHaveLength(0);
    expect((await status(c.connectionId)).state).toBe("no_email");
  });

  it("no duplicates: repeated runs, refreshes and edits never create a second draft", async () => {
    const c = await post("rishii", { name: "Dup Check", company: "Acme", role: "CTO", email: "dup@acme.example" });
    await work();
    await work();
    await work();
    as("rishii");
    await editConnection(new Request(`http://localhost/api/connections/${c.connectionId}`, { method: "PUT", headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ role: "CEO" }) }), { params: Promise.resolve({ connectionId: c.connectionId }) });
    await work();
    expect(google.drafts).toHaveLength(3);
    expect(ledger()).toHaveLength(3);
  });

  it("a SENT draft is never written again, and the Sent counter follows the tracked state", async () => {
    const c = await post("anni", { name: "Sent One", company: "Acme", email: "sent@acme.example" });
    await work();
    const row = sheets.rows("NF_Drafts").find((r) => r[0] === `contact:${c.connectionId}:anni`)!;
    row[5] = "sent"; // what the sent-draft tracker writes when Gmail shows the message sent
    invalidateTableCache();
    expect(await draftListFor("anni")).toMatchObject({ drafted: 0, sent: 1 });
    expect(await status(c.connectionId)).toMatchObject({ state: "drafted", drafted: 3, sent: 1 });
    await work();
    expect(google.drafts).toHaveLength(3);
  });
});

describe("partial availability and retries", () => {
  it("one member's Gmail disconnected: the others get their drafts; the missing one is 'skipped' and drafted after reconnecting", async () => {
    sheets.rows("NF_GmailAccounts").forEach((r, i) => i > 0 && r[0] === "rishii" && (r[4] = "disconnected"));
    invalidateTableCache();
    const c = await post("lukky", { name: "Partial", company: "Acme", email: "p@acme.example" });
    await work();
    expect(mailboxes()).toEqual(["anni", "lukky"]);
    expect(recordsFor(c.connectionId)).toEqual([["anni", "created"], ["lukky", "created"], ["rishii", "skipped_unauthorized"]]);
    expect(await status(c.connectionId)).toMatchObject({ state: "drafted", drafted: 2, skipped: 1 }); // all mailboxes processed
    // Further runs while still disconnected: nothing new, no repeated writes.
    const writes = sheets.calls.filter((x) => x.op !== "get").length;
    expect(await work()).toEqual({ checked: 0, created: 0, remaining: 0 });
    expect(sheets.calls.filter((x) => x.op !== "get").length).toBe(writes);
    // Rishii connects → his draft is created automatically, still one record.
    await connectGmail("rishii");
    expect(await work()).toMatchObject({ checked: 1, created: 1 });
    expect(mailboxes()).toEqual(["anni", "lukky", "rishii"]);
    expect(recordsFor(c.connectionId)).toEqual([["anni", "created"], ["lukky", "created"], ["rishii", "created"]]);
  });

  it("a temporary Gmail failure is recorded and retried by the next run (one record per mailbox)", async () => {
    const c = await post("anni", { name: "Retry", company: "Acme", email: "r@acme.example" });
    const real = google.fn.getMockImplementation()!;
    google.fn.mockImplementation(async (input, init) => (String(input).includes("gmail.googleapis.com") ? new Response("down", { status: 503 }) : real(input, init)));
    await work();
    expect(recordsFor(c.connectionId).map((r) => r[1])).toEqual(["failed", "failed", "failed"]);
    expect((await status(c.connectionId)).state).toBe("drafting");
    google.fn.mockImplementation(real);
    expect(await work()).toMatchObject({ checked: 1, created: 3 });
    expect(recordsFor(c.connectionId).map((r) => r[1])).toEqual(["created", "created", "created"]);
    expect(ledger()).toHaveLength(3);
  });

  it("the Draft counter rises as drafts are created (derived from the records, not incremented)", async () => {
    expect(await draftListFor("lukky")).toMatchObject({ drafted: 0 });
    await post("anni", { name: "One", company: "A", email: "one@a.example" });
    await work();
    expect(await draftListFor("lukky")).toMatchObject({ drafted: 1 });
    await post("rishii", { name: "Two", company: "B", email: "two@b.example" });
    await work();
    expect(await draftListFor("lukky")).toMatchObject({ drafted: 2, sent: 0 });
  });
});

describe("Network Finder contacts and the scheduled cycle", () => {
  it("a Network Finder contact is drafted into all three mailboxes by the same worker", async () => {
    const at = new Date().toISOString();
    sheets.rows("Connections").push(["conn_nf1", "anni", "NF Person", "Acme", "Recruiter", "", "", "", "Source: Network Finder (HN)", "Not Connected", at, at, "nf@acme.example"]);
    invalidateTableCache();
    expect(await work()).toMatchObject({ checked: 1, created: 3 });
    expect(mailboxes()).toEqual(["anni", "lukky", "rishii"]);
  });

  it("manual connections are processed first in every scheduled run (within ~10 minutes), without a second cron job", async () => {
    const c = await post("lukky", { name: "Cycle Person", company: "Acme", email: "cycle@acme.example" });
    const run = await runScheduledCycle({ ...workerDeps(), stores: createSheetsStores() } as Parameters<typeof runScheduledCycle>[0]);
    expect(run.ran).toBe(true);
    expect(run.manualDrafts).toMatchObject({ checked: 1, created: 3 });
    expect(recordsFor(c.connectionId).map((r) => r[1])).toEqual(["created", "created", "created"]);
  });
});

describe("Adam (existing manual connection with no drafts)", () => {
  // A copy of the real record's shape: added by Lukky yesterday, before automatic drafting, no drafts yet.
  const ADAM = "conn_1966746f-6fcc-48cd-b994-eea64c31401d";
  it("is picked up automatically and drafted into all three mailboxes — without creating another Adam or any duplicate", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    sheets.rows("Connections").push([ADAM, "lukky", "Adam", "Evidence", "Ceo", "", "", "Hi Adam", "", "Not Connected", yesterday, yesterday, "adam@evidence.example"]);
    invalidateTableCache();
    expect(await work()).toMatchObject({ checked: 1, created: 3, remaining: 0 });
    expect(mailboxes()).toEqual(["anni", "lukky", "rishii"]);
    expect(recordsFor(ADAM)).toEqual([["anni", "created"], ["lukky", "created"], ["rishii", "created"]]);
    expect(sheets.dataRows("Connections").filter((r) => r[2] === "Adam")).toHaveLength(1);
    await work();
    expect(google.drafts).toHaveLength(3);
    expect((await draftListFor("lukky")).items).toEqual([expect.objectContaining({ company: "Evidence", person: "Adam", designation: "Ceo", status: "Drafted" })]);
  });
});
