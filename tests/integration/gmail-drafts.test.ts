/**
 * Gmail OAuth routes + per-member draft fan-out, end to end on the in-memory spreadsheet.
 * Google (token, revoke, Gmail drafts) is a MOCK fetch; the session is mocked. Nothing real is contacted.
 */
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { GET as connect } from "@/app/api/gmail/connect/route";
import { GET as callback } from "@/app/api/gmail/callback/route";
import { GET as status } from "@/app/api/gmail/status/route";
import { POST as disconnect } from "@/app/api/gmail/disconnect/route";
import type { MemberId } from "@/config/members";
import { GMAIL_COMPOSE_SCOPE } from "@/lib/gmail/config";
import { createDraftFor, isGmailConnected } from "@/lib/gmail/drafts";
import { readDraftLedger, recordDraft } from "@/lib/gmail/store";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { distributeDrafts, type FanoutDeps } from "@/lib/network-finder/draft-fanout";
import { FakeSheets } from "../helpers/fake-sheets";

let sheets: FakeSheets;
let google: ReturnType<typeof mockGoogle>;
const as = (m: MemberId | null) => vi.mocked(getSession).mockResolvedValue(m ? { memberId: m, expiresAt: 9_999_999_999 } : null);
const idToken = (email: string) => `h.${Buffer.from(JSON.stringify({ email, email_verified: true })).toString("base64url")}.s`;

/** Fake Google: hands out per-member tokens and records drafts per access token (= per mailbox). */
function mockGoogle() {
  const drafts: { accessToken: string; raw: string }[] = [];
  const revoked: string[] = [];
  const refreshRefused = new Set<string>();
  const calls: string[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url.split("?")[0]);
    if (url === "https://oauth2.googleapis.com/token") {
      const p = new URLSearchParams(String(init?.body));
      if (p.get("grant_type") === "authorization_code") {
        const who = p.get("code")!.replace("code-for-", "");
        return Response.json({ access_token: `access-${who}`, refresh_token: `refresh-${who}`, scope: `openid email ${GMAIL_COMPOSE_SCOPE}`, id_token: idToken(`${who}@gmail.com`) });
      }
      const rt = p.get("refresh_token")!;
      if (refreshRefused.has(rt)) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: rt.replace("refresh-", "access-") });
    }
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) {
      revoked.push(new URL(url).searchParams.get("token")!);
      return new Response("", { status: 200 });
    }
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/drafts") {
      const auth = (init?.headers as Record<string, string>).Authorization.replace("Bearer ", "");
      drafts.push({ accessToken: auth, raw: JSON.parse(String(init?.body)).message.raw });
      return Response.json({ id: `draft-${drafts.length}` });
    }
    throw new Error(`unexpected request ${url}`);
  });
  return { fn, drafts, revoked, refreshRefused, calls };
}

beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-client.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "test-client-secret");
  vi.stubEnv("GOOGLE_OAUTH_REDIRECT_URI", "http://localhost:3000/api/gmail/callback");
  vi.stubEnv("GMAIL_TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  google = mockGoogle();
  vi.stubGlobal("fetch", google.fn);
});
afterEach(() => {
  setSheetsClientForTesting(null);
  vi.mocked(getSession).mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Runs the whole browser round trip for one member: /connect → Google → /callback. */
async function connectGmail(m: MemberId) {
  as(m);
  const start = await connect(new NextRequest("http://localhost:3000/api/gmail/connect"));
  const nonce = start.cookies.get("jobsync_gmail_oauth")!.value;
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  return callback(new NextRequest(`http://localhost:3000/api/gmail/callback?code=code-for-${m}&state=${encodeURIComponent(state)}`, { headers: { cookie: `jobsync_gmail_oauth=${nonce}` } }));
}

describe("connecting Gmail (OAuth)", () => {
  it("redirects the signed-in member to Google's consent screen with a state cookie", async () => {
    as("anni");
    const res = await connect(new NextRequest("http://localhost:3000/api/gmail/connect"));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.host).toBe("accounts.google.com");
    expect(loc.searchParams.get("client_id")).toBe("test-client.apps.googleusercontent.com");
    expect(res.cookies.get("jobsync_gmail_oauth")).toMatchObject({ httpOnly: true, path: "/api/gmail" });
    expect(res.headers.get("location")).not.toContain("test-client-secret");
  });

  it("requires a session, and says when the server is not configured", async () => {
    as(null);
    expect(new URL((await connect(new NextRequest("http://localhost:3000/api/gmail/connect"))).headers.get("location")!).pathname).toBe("/login");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "");
    as("anni");
    expect((await connect(new NextRequest("http://localhost:3000/api/gmail/connect"))).headers.get("location")).toContain("/gmail?error=not_configured");
  });

  it("stores the member's Gmail with the refresh token ENCRYPTED, nowhere near Connections", async () => {
    const res = await connectGmail("anni");
    expect(res.headers.get("location")).toContain("/gmail?connected=1");
    const [row] = sheets.dataRows("NF_GmailAccounts");
    expect(row.slice(0, 2)).toEqual(["anni", "anni@gmail.com"]);
    expect(row[2].startsWith("v1.")).toBe(true);
    expect(JSON.stringify(sheets.tabs)).not.toContain("refresh-anni"); // never in plain text, in any tab
    expect(row[4]).toBe("connected");
    expect(sheets.dataRows("Connections")).toEqual([]);
  });

  it("rejects a callback for a state issued to another member, a missing cookie, or a refused consent", async () => {
    as("anni");
    const start = await connect(new NextRequest("http://localhost:3000/api/gmail/connect"));
    const nonce = start.cookies.get("jobsync_gmail_oauth")!.value;
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    as("lukky"); // someone else's session finishing Anni's flow
    const swapped = await callback(new NextRequest(`http://localhost:3000/api/gmail/callback?code=code-for-anni&state=${state}`, { headers: { cookie: `jobsync_gmail_oauth=${nonce}` } }));
    expect(swapped.headers.get("location")).toContain("error=invalid_state");
    as("anni");
    const noCookie = await callback(new NextRequest(`http://localhost:3000/api/gmail/callback?code=code-for-anni&state=${state}`));
    expect(noCookie.headers.get("location")).toContain("error=invalid_state");
    const denied = await callback(new NextRequest("http://localhost:3000/api/gmail/callback?error=access_denied"));
    expect(denied.headers.get("location")).toContain("error=denied");
    expect(sheets.dataRows("NF_GmailAccounts")).toEqual([]);
  });

  it("status shows my address but only connected yes/no for others", async () => {
    await connectGmail("anni");
    await connectGmail("lukky");
    as("anni");
    const body = await (await status(new Request("http://localhost/api/gmail/status"))).json();
    expect(body.data.me).toMatchObject({ status: "connected", email: "anni@gmail.com" });
    expect(body.data.members).toEqual([{ id: "anni", connected: true }, { id: "lukky", connected: true }, { id: "rishii", connected: false }]);
    expect(JSON.stringify(body)).not.toContain("lukky@gmail.com");
    expect(JSON.stringify(body)).not.toContain("v1.");
  });

  it("disconnect revokes at Google and deletes only my token", async () => {
    await connectGmail("anni");
    await connectGmail("rishii");
    as("anni");
    const res = await disconnect(new Request("http://localhost/api/gmail/disconnect", { method: "POST", headers: { host: "localhost", origin: "http://localhost" } }));
    expect(res.status).toBe(200);
    expect(google.revoked).toEqual(["refresh-anni"]);
    const rows = sheets.dataRows("NF_GmailAccounts");
    expect(rows.find((r) => r[0] === "anni")!.slice(2, 5)).toEqual(["", rows.find((r) => r[0] === "anni")![3], "disconnected"]);
    expect(rows.find((r) => r[0] === "rishii")![4]).toBe("connected");
    expect(await isGmailConnected("anni")).toBe(false);
    expect(await isGmailConnected("rishii")).toBe(true);
  });
});

describe("drafts in each member's own Gmail", () => {
  const ledger: FanoutDeps["ledger"] = {
    get: async (key) => (await readDraftLedger({ fresh: true })).get(key),
    record: async (e) => recordDraft({ ...e, createdAt: "2026-10-27T05:00:00.000Z" }),
  };
  const deps = (over: Partial<FanoutDeps> = {}): FanoutDeps => ({
    createDraft: (m, msg) => createDraftFor(m, msg),
    isConnected: (m) => isGmailConnected(m),
    compose: async (_m, name) => ({ subject: `Hello from ${name}`, body: `Hi Priya, I'm ${name}.` }),
    ledger,
    ...over,
  });
  const mailbox = (m: string) => google.drafts.filter((d) => d.accessToken === `access-${m}`);

  it("Priya → one draft each in Anni's, Lukky's and Rishii's Gmail, each written as that member, never sent", async () => {
    for (const m of ["anni", "lukky", "rishii"] as const) await connectGmail(m);
    const out = await distributeDrafts({ type: "contact", id: "conn_priya", to: "priya@acme.example" }, deps());
    expect(out.map((o) => [o.memberId, o.result])).toEqual([["anni", "created"], ["lukky", "created"], ["rishii", "created"]]);
    for (const m of ["anni", "lukky", "rishii"]) {
      expect(mailbox(m)).toHaveLength(1);
      expect(Buffer.from(mailbox(m)[0].raw, "base64url").toString("utf8")).toContain("To: priya@acme.example");
    }
    expect(Buffer.from(mailbox("lukky")[0].raw, "base64url").toString("utf8")).toContain("Subject: Hello from Lukky");
    // Only the drafts endpoint was used: nothing can send.
    expect(google.calls.some((u) => /messages\/send|drafts\/send/.test(u))).toBe(false);
  });

  it("a member who has not connected Gmail is skipped; the others still get their drafts", async () => {
    await connectGmail("anni");
    await connectGmail("rishii");
    const out = await distributeDrafts({ type: "contact", id: "conn_priya", to: "priya@acme.example" }, deps());
    expect(out.map((o) => o.result)).toEqual(["created", "not_authorized", "created"]);
    expect(mailbox("lukky")).toHaveLength(0);
  });

  it("running again never creates a second draft in the same mailbox", async () => {
    for (const m of ["anni", "lukky", "rishii"] as const) await connectGmail(m);
    const item = { type: "contact" as const, id: "conn_priya", to: "priya@acme.example" };
    await distributeDrafts(item, deps());
    const again = await distributeDrafts(item, deps());
    expect(again.map((o) => o.result)).toEqual(["already_drafted", "already_drafted", "already_drafted"]);
    expect(google.drafts).toHaveLength(3);
  });

  it("a revoked Gmail is marked for reconnecting without affecting the others", async () => {
    for (const m of ["anni", "lukky", "rishii"] as const) await connectGmail(m);
    google.refreshRefused.add("refresh-lukky");
    const out = await distributeDrafts({ type: "job", id: "job_1" }, deps());
    expect(out.map((o) => o.result)).toEqual(["created", "reauth_required", "created"]);
    expect(sheets.dataRows("NF_GmailAccounts").find((r) => r[0] === "lukky")![4]).toBe("reauth_required");
    // A job draft without an email address has no recipient (to be filled in by the member).
    expect(Buffer.from(mailbox("anni")[0].raw, "base64url").toString("utf8")).not.toContain("To:");
  });

  it("if writing one member's draft fails, the others are still created", async () => {
    for (const m of ["anni", "lukky", "rishii"] as const) await connectGmail(m);
    const out = await distributeDrafts({ type: "contact", id: "conn_x" }, deps({
      compose: async (m, name) => {
        if (m === "anni") throw new Error("nemotron down");
        return { subject: `From ${name}`, body: "Hi" };
      },
    }));
    expect(out.map((o) => o.result)).toEqual(["failed", "created", "created"]);
  });

  it("one member's stored token can never be used for another member's mailbox", async () => {
    await connectGmail("anni");
    // Someone copies Anni's encrypted token into a row for Rishii.
    const anniRow = sheets.dataRows("NF_GmailAccounts")[0];
    sheets.rows("NF_GmailAccounts").push(["rishii", "rishii@gmail.com", anniRow[2], anniRow[3], "connected", anniRow[5], anniRow[6], ""]);
    const res = await createDraftFor("rishii", { subject: "S", body: "B" });
    expect(res).toEqual({ status: "reauth_required" });
    expect(google.drafts).toHaveLength(0);
  });
});
