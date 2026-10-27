/**
 * Manually added connections → a personalised Gmail draft in the adding member's own Gmail, through the SAME
 * draft step as Network Finder (NF_Drafts ledger, full names, never sent). Google is a MOCK fetch; the session is
 * mocked; the spreadsheet is in memory. Nothing real is contacted.
 */
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/session")>()), getSession: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { POST as addConnection } from "@/app/api/connections/route";
import { PUT as editConnection } from "@/app/api/connections/[connectionId]/route";
import { GET as draftStatus, POST as createDraft } from "@/app/api/connections/[connectionId]/draft/route";
import { GET as connect } from "@/app/api/gmail/connect/route";
import { GET as callback } from "@/app/api/gmail/callback/route";
import type { MemberId } from "@/config/members";
import { draftForManualConnection } from "@/lib/gmail/connection-draft";
import { draftListFor } from "@/lib/gmail/draft-list";
import { GMAIL_COMPOSE_SCOPE } from "@/lib/gmail/config";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { invalidateTableCache } from "@/lib/google-sheets/table";
import type { Connection } from "@/types/domain";
import { FakeSheets } from "../helpers/fake-sheets";

let sheets: FakeSheets;
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
const post = (m: MemberId, body: Record<string, unknown>) => {
  as(m);
  return addConnection(new Request("http://localhost/api/connections", { method: "POST", headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify(body) }));
};
const ledger = () => sheets.dataRows("NF_Drafts");

beforeEach(async () => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
  invalidateTableCache();
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-client.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "test-client-secret");
  vi.stubEnv("GOOGLE_OAUTH_REDIRECT_URI", "http://localhost:3000/api/gmail/callback");
  vi.stubEnv("GMAIL_TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("NEMOTRON_API_KEY", ""); // the built-in writer (Nemotron is covered by its own tests)
  google = mockGoogle();
  vi.stubGlobal("fetch", google.fn);
  for (const m of ["anni", "lukky", "rishii"] as const) await connectGmail(m);
  google.drafts.length = 0;
});
afterEach(() => {
  setSheetsClientForTesting(null);
  vi.mocked(getSession).mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("manual connection → Gmail draft", () => {
  it("a connection with an email gets ONE draft in the adder's own Gmail, signed with their full name, recorded in NF_Drafts", async () => {
    const res = await post("lukky", { name: "Adam Test", company: "Evidence", role: "CEO", email: "adam@evidence.example" });
    expect(res.status).toBe(201);
    const created = (await res.json()).data as Connection;

    expect(google.drafts.map((d) => d.mailbox)).toEqual(["lukky"]); // only Lukky's mailbox
    const { head, body } = decode(google.drafts[0].raw);
    expect(head).toContain("To: adam@evidence.example");
    expect(head).not.toMatch(/^From:/m); // Gmail uses Lukky's own account; no impersonation
    expect(body).toContain("Lakshya Singh");
    expect(body.endsWith("Best regards,\nLakshya Singh")).toBe(true);
    expect(body).not.toMatch(/\b(Lukky|Aniket Raj|Rishi Raj)\b/);
    expect(body).toContain("Evidence");

    expect(ledger()).toHaveLength(1);
    expect(ledger()[0].slice(0, 6)).toEqual([`contact:${created.connectionId}:lukky`, "lukky", "contact", created.connectionId, "draft-1", "created"]);
    // Only the drafts endpoint: nothing can send.
    expect(google.calls.some((u) => /send/.test(u))).toBe(false);

    // The Gmail Drafts page data picks it up for Lukky (and not for anyone else).
    const list = await draftListFor("lukky");
    expect(list).toMatchObject({ drafted: 1, sent: 0 });
    expect(list.items[0]).toMatchObject({ company: "Evidence", person: "Adam Test", designation: "CEO", email: "adam@evidence.example", status: "Drafted" });
    expect((await draftListFor("anni")).items).toHaveLength(0);
  });

  it("each member's manual connection goes to THEIR mailbox with THEIR full name", async () => {
    for (const [m, full] of [["anni", "Aniket Raj"], ["lukky", "Lakshya Singh"], ["rishii", "Rishi Raj"]] as const) {
      google.drafts.length = 0;
      await post(m, { name: `Person ${m}`, company: "Acme", role: "Recruiter", email: `p.${m}@acme.example` });
      expect(google.drafts.map((d) => d.mailbox)).toEqual([m]);
      expect(decode(google.drafts[0].raw).body).toContain(full);
    }
  });

  it("no email → no draft attempt, no ledger row; the connection is saved normally", async () => {
    const res = await post("anni", { name: "No Email Person", company: "Acme" });
    expect(res.status).toBe(201);
    expect(google.drafts).toHaveLength(0);
    expect(ledger()).toHaveLength(0);
    expect(sheets.dataRows("Connections").some((r) => r[2] === "No Email Person")).toBe(true);
  });

  it("never a duplicate: retries, re-runs and edits do not create a second draft", async () => {
    const created = (await (await post("rishii", { name: "Dup Check", company: "Acme", role: "CTO", email: "dup@acme.example" })).json()).data as Connection;
    expect(google.drafts).toHaveLength(1);
    // A retry / second run of the draft step for the same connection.
    const again = await draftForManualConnection(created);
    expect(again).toEqual({ outcomes: [{ memberId: "rishii", result: "already_drafted" }] });
    await draftForManualConnection(created);
    // Editing the connection does not draft again.
    as("rishii");
    const edit = await editConnection(new Request(`http://localhost/api/connections/${created.connectionId}`, { method: "PUT", headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ role: "CEO" }) }), { params: Promise.resolve({ connectionId: created.connectionId }) });
    expect(edit.status).toBe(200);
    expect(google.drafts).toHaveLength(1);
    expect(ledger()).toHaveLength(1);
  });

  it("a member without Gmail connected: the connection is saved; the draft is recorded as skipped (not created, nothing broken)", async () => {
    sheets.rows("NF_GmailAccounts").forEach((r, i) => i > 0 && r[0] === "anni" && (r[4] = "disconnected"));
    invalidateTableCache();
    const res = await post("anni", { name: "Later Person", company: "Acme", email: "later@acme.example" });
    expect(res.status).toBe(201);
    expect(google.drafts).toHaveLength(0);
    expect(ledger().map((r) => r[5])).toEqual(["skipped_unauthorized"]);
    expect((await draftListFor("anni")).items).toHaveLength(0);
  });

  it("Network Finder contacts are left to Network Finder (no extra draft from this path)", async () => {
    const nf: Connection = { connectionId: "conn_nf1", memberId: "anni", name: "NF Person", company: "Acme", email: "nf@acme.example", notes: "Source: Network Finder (HN)", status: "Not Connected", createdAt: "2026-10-27T10:00:00.000Z", updatedAt: "2026-10-27T10:00:00.000Z" };
    expect(await draftForManualConnection(nf)).toEqual({ skipped: "network_finder" });
    expect(google.drafts).toHaveLength(0);
  });

  it("the saved connection is returned even if drafting fails (Gmail down): the save never depends on Gmail", async () => {
    google.fn.mockImplementation(async (input: string | URL | Request) => {
      if (String(input).includes("gmail.googleapis.com")) return new Response("down", { status: 503 });
      return Response.json({ access_token: "access-anni" });
    });
    const res = await post("anni", { name: "Resilient", company: "Acme", email: "r@acme.example" });
    expect(res.status).toBe(201);
    expect(sheets.dataRows("Connections").some((r) => r[2] === "Resilient")).toBe(true);
    expect(ledger().map((r) => r[5])).toEqual(["failed"]);
  });
});

describe("Create Gmail Draft action (catch-up / retry)", () => {
  // A copy of the real Adam record's shape: added by Lukky before automatic drafting existed, so no draft yet.
  const ADAM = "conn_1966746f-6fcc-48cd-b994-eea64c31401d";
  const seedAdam = (email = "adam@evidence.example") => {
    sheets.rows("Connections").push([ADAM, "lukky", "Adam", "Evidence", "Ceo", "", "", "Hi Adam", "", "Not Connected", "2026-10-26T17:42:24.438Z", "2026-10-26T17:42:24.438Z", email]);
    invalidateTableCache();
  };
  const call = (m: MemberId, method: "GET" | "POST", id = ADAM) => {
    as(m);
    const req = new Request(`http://localhost/api/connections/${id}/draft`, { method, headers: { host: "localhost", origin: "http://localhost" } });
    return (method === "GET" ? draftStatus : createDraft)(req, { params: Promise.resolve({ connectionId: id }) });
  };

  it("Adam: Lukky (the owner) creates exactly ONE draft in Lukky's Gmail, signed Lakshya Singh, recorded in NF_Drafts", async () => {
    seedAdam();
    expect((await (await call("lukky", "GET")).json()).data).toEqual({ status: "none", hasEmail: true });
    const res = await call("lukky", "POST");
    expect(res.status).toBe(201);
    expect((await res.json()).data.result).toBe("created");
    expect(google.drafts.map((d) => d.mailbox)).toEqual(["lukky"]);
    const { head, body } = decode(google.drafts[0].raw);
    expect(head).toContain("To: adam@evidence.example");
    expect(body.endsWith("Best regards,\nLakshya Singh")).toBe(true);
    expect(body).toContain("Evidence");
    expect(ledger().map((r) => r.slice(0, 6))).toEqual([[`contact:${ADAM}:lukky`, "lukky", "contact", ADAM, "draft-1", "created"]]);
    expect((await (await call("lukky", "GET")).json()).data.status).toBe("created");
    // Gmail Drafts page data for Lukky.
    expect((await draftListFor("lukky")).items).toEqual([expect.objectContaining({ company: "Evidence", person: "Adam", designation: "Ceo", email: "adam@evidence.example", status: "Drafted" })]);
    expect(google.calls.some((u) => /send/.test(u))).toBe(false);
  });

  it("a second click (or retry) says 'Draft already exists.' and creates nothing", async () => {
    seedAdam();
    await call("lukky", "POST");
    const again = await call("lukky", "POST");
    expect(again.status).toBe(200);
    expect((await again.json()).data).toEqual({ result: "already_drafted", message: "Draft already exists." });
    expect(google.drafts).toHaveLength(1);
    expect(ledger()).toHaveLength(1);
  });

  it("a SENT draft is never written again", async () => {
    seedAdam();
    sheets.rows("NF_Drafts").push([`contact:${ADAM}:lukky`, "lukky", "contact", ADAM, "gd-old", "sent", "2026-10-27T10:00:00.000Z", "", "t-old", "2026-10-27T11:00:00.000Z"]);
    invalidateTableCache();
    expect((await (await call("lukky", "POST")).json()).data.result).toBe("already_drafted");
    expect(google.drafts).toHaveLength(0);
  });

  it("a FAILED draft is retried under the same record (no second row)", async () => {
    seedAdam();
    sheets.rows("NF_Drafts").push([`contact:${ADAM}:lukky`, "lukky", "contact", ADAM, "", "failed", "2026-10-27T10:00:00.000Z", "Error", "", ""]);
    invalidateTableCache();
    expect((await (await call("lukky", "GET")).json()).data.status).toBe("failed");
    const res = await call("lukky", "POST");
    expect(res.status).toBe(201);
    expect(google.drafts.map((d) => d.mailbox)).toEqual(["lukky"]);
    expect(ledger()).toHaveLength(1);
    expect(ledger()[0][5]).toBe("created");
  });

  it("non-owners can neither see the state nor draft — and nothing reaches any mailbox", async () => {
    seedAdam();
    for (const m of ["anni", "rishii"] as const) {
      const post = await call(m, "POST");
      expect(post.status).toBe(403);
      expect((await post.json()).error.code).toBe("not_connection_owner");
      expect((await call(m, "GET")).status).toBe(403);
    }
    expect(google.drafts).toHaveLength(0);
    expect(ledger()).toHaveLength(0);
    as(null);
    expect((await createDraft(new Request(`http://localhost/api/connections/${ADAM}/draft`, { method: "POST", headers: { host: "localhost", origin: "http://localhost" } }), { params: Promise.resolve({ connectionId: ADAM }) })).status).toBe(401);
  });

  it("no email → 400, no draft, no record", async () => {
    seedAdam("");
    const res = await call("lukky", "POST");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("no_email");
    expect(google.drafts).toHaveLength(0);
    expect(ledger()).toHaveLength(0);
  });

  it("owner without Gmail connected → 409 'connect your Gmail', recorded as skipped, retryable later", async () => {
    seedAdam();
    sheets.rows("NF_GmailAccounts").forEach((r, i) => i > 0 && r[0] === "lukky" && (r[4] = "disconnected"));
    invalidateTableCache();
    const res = await call("lukky", "POST");
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("gmail_not_connected");
    expect(ledger().map((r) => r[5])).toEqual(["skipped_unauthorized"]);
    // Reconnect → the button works and still leaves ONE record.
    await connectGmail("lukky");
    expect((await call("lukky", "POST")).status).toBe(201);
    expect(ledger()).toHaveLength(1);
    expect(ledger()[0][5]).toBe("created");
  });

  it("Gmail failure → 502 'could not be created', recorded failed (the button then offers Retry)", async () => {
    seedAdam();
    google.fn.mockImplementation(async (input: string | URL | Request) => (String(input).includes("gmail.googleapis.com") ? new Response("down", { status: 503 }) : Response.json({ access_token: "access-lukky" })));
    const res = await call("lukky", "POST");
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("draft_failed");
    expect(ledger()[0][5]).toBe("failed");
  });

  it("unknown connection → 404", async () => {
    expect((await call("lukky", "POST", "conn_does-not-exist")).status).toBe(404);
  });
});
