/**
 * The Gmail send primitives against a MOCK fetch. No network, no real mailbox; `accessFor` and the account store are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const state = { scopes: ["https://www.googleapis.com/auth/gmail.compose"], access: "ok" as "ok" | "reauth_required" | "not_authorized" };
const updateGmailStatus = vi.fn(async () => undefined);

vi.mock("@/lib/gmail/drafts", () => ({
  GMAIL_API: "https://gmail.googleapis.com/gmail/v1/users/me",
  DRAFTS_ENDPOINT: "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
  accessFor: vi.fn(async () => (state.access === "ok" ? { ok: true, token: "tok", scopes: state.scopes } : { ok: false, status: state.access })),
}));
vi.mock("@/lib/gmail/store", () => ({ updateGmailStatus: (...a: unknown[]) => updateGmailStatus(...(a as [])) }));

import { classifySendResponse, parseDraftReadback, readDraftFor, reconcileDraftSend, sendDraftFor } from "@/lib/gmail/send";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const METADATA = "https://www.googleapis.com/auth/gmail.metadata";

beforeEach(() => {
  state.scopes = ["https://www.googleapis.com/auth/gmail.compose"];
  state.access = "ok";
  updateGmailStatus.mockClear();
});

describe("classifySendResponse", () => {
  it("only a 2xx with a message id AND the SENT label is a confirmed send", () => {
    expect(classifySendResponse(200, { id: "m1", threadId: "t1", labelIds: ["SENT"] })).toEqual({ status: "sent", messageId: "m1", threadId: "t1" });
    expect(classifySendResponse(200, { id: "m1", labelIds: ["INBOX"] }).status).toBe("uncertain");
    expect(classifySendResponse(200, { labelIds: ["SENT"] }).status).toBe("uncertain");
    expect(classifySendResponse(200, {}).status).toBe("uncertain");
  });
  it("quota and rate limits are definitely not sent", () => {
    expect(classifySendResponse(429, {}, "60")).toEqual({ status: "rate_limited", retryAfterMs: 60_000 });
    expect(classifySendResponse(403, { error: { errors: [{ reason: "userRateLimitExceeded" }] } }).status).toBe("rate_limited");
    expect(classifySendResponse(403, { error: { errors: [{ reason: "dailyLimitExceeded" }] } }).status).toBe("rate_limited");
  });
  it("auth, permanent and ambiguous failures", () => {
    expect(classifySendResponse(401, {}).status).toBe("auth_failed");
    expect(classifySendResponse(403, { error: { errors: [{ reason: "insufficientPermissions" }] } }).status).toBe("auth_failed");
    expect(classifySendResponse(400, { error: { message: "Invalid To header" } })).toEqual({ status: "rejected", reason: "Invalid To header" });
    expect(classifySendResponse(404, {}).status).toBe("draft_missing");
    expect(classifySendResponse(500, {}).status).toBe("uncertain");
    expect(classifySendResponse(503, {}).status).toBe("uncertain");
  });
});

describe("sendDraftFor", () => {
  const send = (impl: () => Promise<Response>) => {
    const fetchFn = vi.fn(impl) as unknown as typeof fetch;
    return { fetchFn, call: () => sendDraftFor("anni", "draft1", fetchFn), calls: () => (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls };
  };

  it("posts the draft id to drafts.send with the member's own token and returns the confirmed message", async () => {
    const s = send(async () => json(200, { id: "m1", threadId: "t1", labelIds: ["SENT"] }));
    expect(await s.call()).toEqual({ status: "sent", messageId: "m1", threadId: "t1" });
    const [url, init] = s.calls()[0] as [string, RequestInit];
    expect(url).toBe(`${GMAIL_API}/drafts/send`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(String(init.body))).toEqual({ id: "draft1" });
  });

  it("a timeout / network error AFTER submitting is uncertain, never 'failed', and is not retried inside the call", async () => {
    const s = send(async () => { throw new DOMException("timeout", "TimeoutError"); });
    expect(await s.call()).toEqual({ status: "uncertain", reason: "no response from Gmail (timeout or network error)" });
    expect(s.calls()).toHaveLength(1);
  });

  it("5xx and an unconfirmed 2xx are uncertain; 429/403-quota are rate_limited; 400 rejected; 404 draft_missing", async () => {
    expect((await send(async () => json(503, {})).call()).status).toBe("uncertain");
    expect((await send(async () => json(200, { id: "x" })).call()).status).toBe("uncertain");
    expect((await send(async () => json(429, {}, { "retry-after": "5" })).call())).toEqual({ status: "rate_limited", retryAfterMs: 5000 });
    expect((await send(async () => json(400, { error: { message: "bad" } })).call()).status).toBe("rejected");
    expect((await send(async () => json(404, {})).call()).status).toBe("draft_missing");
  });

  it("a 401 marks the member's Gmail as needing re-authorisation (and is not sent)", async () => {
    const r = await send(async () => json(401, {})).call();
    expect(r.status).toBe("auth_failed");
    expect(updateGmailStatus).toHaveBeenCalledTimes(1);
  });

  it("no usable authorisation -> no request is made at all", async () => {
    state.access = "reauth_required";
    const s = send(async () => json(200, {}));
    expect(await s.call()).toEqual({ status: "no_access", access: "reauth_required" });
    expect(s.calls()).toHaveLength(0);
  });
});

describe("readDraftFor / parseDraftReadback", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
  const full = {
    id: "d1",
    message: {
      threadId: "t1",
      payload: {
        mimeType: "multipart/mixed",
        headers: [{ name: "To", value: "Jane <jane@acme.example.com>" }, { name: "Subject", value: "Application for Software Engineer — Acme" }, { name: "From", value: "me@gmail.test" }],
        parts: [
          { mimeType: "text/plain", filename: "", body: { size: 10, data: b64("Dear Jane,\r\n\r\nHello") } },
          { mimeType: "application/pdf", filename: "Aniket_Raj_SDE.pdf", body: { attachmentId: "a1", size: 110866 } },
        ],
      },
    },
  };
  it("extracts recipient, subject, text body, attachments (name + size) and thread", () => {
    expect(parseDraftReadback(full)).toEqual({
      to: "Jane <jane@acme.example.com>", from: "me@gmail.test", subject: "Application for Software Engineer — Acme", body: "Dear Jane,\n\nHello", attachments: [{ filename: "Aniket_Raj_SDE.pdf", size: 110866 }], threadId: "t1",
    });
    expect(parseDraftReadback({})).toBeNull();
  });
  it("404 -> not_found, 403 -> no_access, 500 -> error, 200 -> ok", async () => {
    const run = (res: Response) => readDraftFor("anni", "d1", vi.fn(async () => res) as unknown as typeof fetch);
    expect((await run(json(404, {}))).status).toBe("not_found");
    expect((await run(json(403, {}))).status).toBe("no_access");
    expect((await run(json(500, {}))).status).toBe("error");
    expect((await run(json(200, full))).status).toBe("ok");
  });
});

describe("reconcileDraftSend: never guesses", () => {
  const route = (map: Record<string, Response | "throw">) =>
    vi.fn(async (url: string | URL | Request) => {
      const key = Object.keys(map).find((k) => String(url).includes(k));
      const v = key ? map[key] : json(500, {});
      if (v === "throw") throw new Error("net");
      return v.clone();
    }) as unknown as typeof fetch;

  it("draft still exists -> NOT sent (safe to send again)", async () => {
    expect(await reconcileDraftSend("anni", "d1", "t1", route({ "/drafts/d1": json(200, { id: "d1" }) }))).toEqual({ state: "not_sent" });
  });
  it("draft gone + thread has a SENT message (metadata permission) -> sent, with the message id", async () => {
    state.scopes = [...state.scopes, METADATA];
    const f = route({ "/drafts/d1": json(404, {}), "/threads/t1": json(200, { messages: [{ id: "m9", labelIds: ["SENT"] }] }) });
    expect(await reconcileDraftSend("anni", "d1", "t1", f)).toEqual({ state: "sent", messageId: "m9" });
  });
  it("draft gone + thread shows no sent message -> unknown (deleted?), never 'not sent'", async () => {
    state.scopes = [...state.scopes, METADATA];
    const f = route({ "/drafts/d1": json(404, {}), "/threads/t1": json(200, { messages: [{ id: "m1", labelIds: ["DRAFT"] }] }) });
    expect((await reconcileDraftSend("anni", "d1", "t1", f)).state).toBe("unknown");
  });
  it("draft gone without the metadata permission, or without a thread id -> unknown", async () => {
    const f = route({ "/drafts/d1": json(404, {}) });
    expect(await reconcileDraftSend("anni", "d1", "t1", f)).toMatchObject({ state: "unknown", reason: expect.stringMatching(/metadata permission/) });
    state.scopes = [...state.scopes, METADATA];
    expect((await reconcileDraftSend("anni", "d1", undefined, f)).state).toBe("unknown");
  });
  it("Gmail unreachable or unauthorised -> unknown", async () => {
    expect((await reconcileDraftSend("anni", "d1", "t1", route({ "/drafts/d1": "throw" }))).state).toBe("unknown");
    state.access = "reauth_required";
    expect((await reconcileDraftSend("anni", "d1", "t1", route({}))).state).toBe("unknown");
  });
});
