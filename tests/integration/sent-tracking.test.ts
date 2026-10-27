/**
 * "Was the draft sent?" tracking, end to end on the in-memory spreadsheet with a MOCK Gmail per member.
 * Uses the real Connections service, the real draft ledger and the real Gmail access code.
 */
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { GET as connect } from "@/app/api/gmail/connect/route";
import { GET as callback } from "@/app/api/gmail/callback/route";
import type { MemberId } from "@/config/members";
import { GMAIL_COMPOSE_SCOPE, GMAIL_METADATA_SCOPE } from "@/lib/gmail/config";
import { createDraftFor, isGmailConnected } from "@/lib/gmail/drafts";
import { readDraftLedger, recordDraft } from "@/lib/gmail/store";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { createConnection, updateConnection } from "@/lib/google-sheets/connections-service";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { distributeDrafts } from "@/lib/network-finder/draft-fanout";
import { existingSentTrackerDeps } from "@/lib/network-finder/gateways";
import { runSentTracking } from "@/lib/network-finder/sent-tracker";
import { FakeSheets } from "../helpers/fake-sheets";

let sheets: FakeSheets;
let gmail: ReturnType<typeof mockGmail>;
const MEMBERS: MemberId[] = ["anni", "lukky", "rishii"];
const as = (m: MemberId) => vi.mocked(getSession).mockResolvedValue({ memberId: m, expiresAt: 9_999_999_999 });

/** One fake mailbox per member (keyed by access token). Members can send or delete drafts "in Gmail". */
function mockGmail() {
  type Draft = { id: string; threadId: string; state: "draft" | "sent" | "deleted" };
  const boxes = new Map<string, Map<string, Draft>>(); // access token -> drafts
  const noMetadata = new Set<string>(); // members who did not grant the metadata permission
  const requests: { method: string; url: string }[] = [];
  let n = 0;
  const box = (token: string) => boxes.get(token) ?? boxes.set(token, new Map()).get(token)!;
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ method, url: url.split("?")[0] });
    if (url === "https://oauth2.googleapis.com/token") {
      const p = new URLSearchParams(String(init?.body));
      if (p.get("grant_type") === "authorization_code") {
        const who = p.get("code")!.replace("code-for-", "");
        const scope = `openid email ${GMAIL_COMPOSE_SCOPE}${noMetadata.has(who) ? "" : ` ${GMAIL_METADATA_SCOPE}`}`;
        return Response.json({ access_token: `access-${who}`, refresh_token: `refresh-${who}`, scope, id_token: `h.${Buffer.from(JSON.stringify({ email: `${who}@gmail.com` })).toString("base64url")}.s` });
      }
      return Response.json({ access_token: p.get("refresh_token")!.replace("refresh-", "access-") });
    }
    const token = (init?.headers as Record<string, string>)?.Authorization?.replace("Bearer ", "") ?? "";
    const base = "https://gmail.googleapis.com/gmail/v1/users/me";
    if (url === `${base}/drafts` && method === "POST") {
      const d = { id: `d${++n}`, threadId: `t${n}`, state: "draft" as const };
      box(token).set(d.id, d);
      return Response.json({ id: d.id, message: { id: `m${n}`, threadId: d.threadId } });
    }
    const draftMatch = url.match(new RegExp(`^${base}/drafts/([^?]+)`));
    if (draftMatch && method === "GET") {
      const d = box(token).get(draftMatch[1]);
      return d?.state === "draft" ? Response.json({ id: d.id, message: { threadId: d.threadId } }) : Response.json({ error: { code: 404 } }, { status: 404 });
    }
    const threadMatch = url.match(new RegExp(`^${base}/threads/([^?]+)`));
    if (threadMatch && method === "GET") {
      const d = [...box(token).values()].find((x) => x.threadId === threadMatch[1]);
      if (!d || d.state === "deleted") return Response.json({ error: { code: 404 } }, { status: 404 });
      return Response.json({ id: d.threadId, messages: [{ id: "m", labelIds: d.state === "sent" ? ["SENT"] : ["DRAFT"] }] });
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  /** What the member does in Gmail. */
  const act = (member: string, state: "sent" | "deleted") => {
    for (const d of box(`access-${member}`).values()) d.state = state;
  };
  return { fn, act, noMetadata, requests };
}

beforeEach(async () => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-client.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "test-client-secret");
  vi.stubEnv("GOOGLE_OAUTH_REDIRECT_URI", "http://localhost:3000/api/gmail/callback");
  vi.stubEnv("GMAIL_TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("GMAIL_TRACK_SENT", "true");
  gmail = mockGmail();
  vi.stubGlobal("fetch", gmail.fn);
});
afterEach(() => {
  setSheetsClientForTesting(null);
  vi.mocked(getSession).mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function connectGmail(m: MemberId) {
  as(m);
  const start = await connect(new NextRequest("http://localhost:3000/api/gmail/connect"));
  const nonce = start.cookies.get("jobsync_gmail_oauth")!.value;
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  await callback(new NextRequest(`http://localhost:3000/api/gmail/callback?code=code-for-${m}&state=${encodeURIComponent(state)}`, { headers: { cookie: `jobsync_gmail_oauth=${nonce}` } }));
}

/** Network Finder saved Priya (owned by Anni) and drafted her in all three Gmail accounts. */
async function priyaWithDrafts() {
  for (const m of MEMBERS) await connectGmail(m);
  const priya = await createConnection("anni", { name: "Priya Sharma", company: "Acme", email: "priya@acme.example", status: "Not Connected" });
  await distributeDrafts({ type: "contact", id: priya.connectionId, to: "priya@acme.example" }, {
    createDraft: (m, msg) => createDraftFor(m, msg),
    isConnected: (m) => isGmailConnected(m),
    compose: async (_m, name) => ({ subject: `Hello from ${name}`, body: "Hi Priya" }),
    ledger: { get: async (k) => (await readDraftLedger({ fresh: true })).get(k), record: (e) => recordDraft({ ...e, createdAt: "2026-10-27T05:00:00.000Z" }) },
  });
  return priya;
}
const status = (id: string) => sheets.dataRows("Connections").find((r) => r[0] === id)![9];
const ledger = async () => Object.fromEntries([...(await readDraftLedger({ fresh: true })).values()].map((d) => [d.memberId, d.status]));
const track = () => runSentTracking(existingSentTrackerDeps());

describe("sent-draft tracking", () => {
  it("drafts still in Gmail: nothing changes", async () => {
    const priya = await priyaWithDrafts();
    const r = await track();
    expect(r).toMatchObject({ checked: 3, stillDrafts: 3, sent: [], markedMessaged: [] });
    expect(status(priya.connectionId)).toBe("Not Connected");
  });

  it("Lukky sends his draft: Priya becomes Messaged; each member is tracked separately", async () => {
    const priya = await priyaWithDrafts();
    gmail.act("lukky", "sent");
    const r = await track();
    expect(r.sent).toEqual([{ memberId: "lukky", connectionId: priya.connectionId }]);
    expect(r.markedMessaged).toEqual([priya.connectionId]);
    expect(status(priya.connectionId)).toBe("Messaged");
    expect(await ledger()).toEqual({ anni: "created", lukky: "sent", rishii: "created" });

    // Later Anni sends hers too: recorded for Anni, no second status change.
    gmail.act("anni", "sent");
    const again = await track();
    expect(again.sent).toEqual([{ memberId: "anni", connectionId: priya.connectionId }]);
    expect(again.markedMessaged).toEqual([]); // already Messaged
    expect(await ledger()).toEqual({ anni: "sent", lukky: "sent", rishii: "created" });
  });

  it("a draft deleted without sending leaves the status unchanged and stops being checked", async () => {
    const priya = await priyaWithDrafts();
    gmail.act("rishii", "deleted");
    const r = await track();
    expect(r).toMatchObject({ deleted: 1, sent: [], markedMessaged: [] });
    expect(status(priya.connectionId)).toBe("Not Connected");
    expect((await ledger()).rishii).toBe("deleted");
    expect((await track()).checked).toBe(2); // Rishii's is no longer tracked
  });

  it("never downgrades a connection that is already Connected or Reply, and never marks Connected", async () => {
    const priya = await priyaWithDrafts();
    await updateConnection("anni", priya.connectionId, { status: "Reply" });
    gmail.act("lukky", "sent");
    const r = await track();
    expect(r.sent).toHaveLength(1);
    expect(r.markedMessaged).toEqual([]);
    expect(status(priya.connectionId)).toBe("Reply");
  });

  it("without the metadata permission a vanished draft is 'unknown' and nothing changes", async () => {
    gmail.noMetadata.add("lukky");
    const priya = await priyaWithDrafts();
    gmail.act("lukky", "sent");
    const r = await track();
    expect(r).toMatchObject({ unknown: 1, sent: [], markedMessaged: [] });
    expect(status(priya.connectionId)).toBe("Not Connected");
    expect((await ledger()).lukky).toBe("created"); // asked again on later runs
  });

  it("a connection deleted in JobSync is simply skipped", async () => {
    const priya = await priyaWithDrafts();
    sheets.rows("Connections").splice(1, 1); // removed by hand
    gmail.act("anni", "sent");
    const r = await track();
    expect(r.sent).toHaveLength(1);
    expect(r.markedMessaged).toEqual([]);
    expect(sheets.dataRows("Connections").some((row) => row[0] === priya.connectionId)).toBe(false);
  });

  it("only reads Gmail: after the drafts are created, every Gmail request is a GET to drafts or threads", async () => {
    await priyaWithDrafts();
    gmail.requests.length = 0;
    gmail.act("lukky", "sent");
    gmail.act("rishii", "deleted");
    await track();
    const gmailCalls = gmail.requests.filter((r) => r.url.startsWith("https://gmail.googleapis.com"));
    expect(gmailCalls.length).toBeGreaterThan(0);
    expect(gmailCalls.every((r) => r.method === "GET" && /\/(drafts|threads)\//.test(r.url))).toBe(true);
    expect(gmail.requests.some((r) => /send|trash|delete|modify|batchModify/.test(r.url))).toBe(false);
  });

  it("a member who is not connected any more is 'unknown' (others still checked)", async () => {
    const priya = await priyaWithDrafts();
    const row = sheets.rows("NF_GmailAccounts").find((r) => r[0] === "anni")!;
    row[4] = "disconnected";
    row[2] = "";
    gmail.act("anni", "sent");
    gmail.act("rishii", "sent");
    const r = await track();
    expect(r.unknown).toBe(1);
    expect(r.sent.map((s) => s.memberId)).toEqual(["rishii"]);
    expect(status(priya.connectionId)).toBe("Messaged");
  });
});
