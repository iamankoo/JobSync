import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { GET as pollRoute } from "@/app/api/chat/poll/route";
import { POST as callRoute } from "@/app/api/chat/call/route";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { deriveActiveCall, PRESENCE_MS } from "@/lib/google-sheets/call-service";
import { setPushSenderForTesting, resetPushDedupeForTesting, type PushSender } from "@/lib/push/notify";
import type { MemberId } from "@/config/members";
import type { CallSignal } from "@/types/domain";
import { FakeSheets } from "../helpers/fake-sheets";

let sheets: FakeSheets;
const as = (m: MemberId | null) => vi.mocked(getSession).mockResolvedValue(m ? { memberId: m, expiresAt: 9_999_999_999 } : null);
const post = (data: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/chat/call", { method: "POST", headers: { "content-type": "application/json", host: "localhost", ...headers }, body: JSON.stringify(data) });
async function act(m: MemberId, body: Record<string, unknown>) {
  as(m);
  const res = await callRoute(post(body));
  return { status: res.status, body: await res.json() };
}
async function poll(m: MemberId, since = "") {
  as(m);
  const res = await pollRoute(new Request(`http://localhost/api/chat/poll?after=0${since ? `&since=${encodeURIComponent(since)}` : ""}`, { headers: { host: "localhost" } }));
  return (await res.json()).data as { call: { active: { callId: string; media: string; participants: MemberId[]; startedBy: MemberId } | null; signals: CallSignal[]; cursor: string } };
}

let pushed: { member: MemberId; title: string; url: string }[];
beforeEach(() => {
  vi.stubEnv("VAPID_PUBLIC_KEY", "pub");
  vi.stubEnv("VAPID_PRIVATE_KEY", "priv");
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
  resetPushDedupeForTesting();
  pushed = [];
  // One subscription per member so we can see who is told about a call.
  for (const m of ["anni", "lukky", "rishii"]) sheets.rows("PushSubscriptions").push([`sub_${m}`, m, `https://fcm.googleapis.com/fcm/send/${m}`, "k", "a", new Date().toISOString(), new Date().toISOString()]);
  setPushSenderForTesting((async (sub, payload) => {
    pushed.push({ member: sub.memberId, title: payload.title, url: payload.url });
    return { ok: true };
  }) as PushSender);
});
afterEach(() => {
  setSheetsClientForTesting(null);
  setPushSenderForTesting(null);
  vi.mocked(getSession).mockReset();
  vi.unstubAllEnvs();
});

describe("call signalling", () => {
  it("starting a call announces it in the chat, notifies the OTHER two members, and shows it to everyone", async () => {
    const r = await act("anni", { action: "start", media: "video" });
    expect(r.status).toBe(201);
    expect(r.body.data.call).toMatchObject({ media: "video", startedBy: "anni", participants: ["anni"] });
    expect(sheets.dataRows("ChatMessages").map((x) => [x[1], x[2], x[3]])).toEqual([["anni", "call", "Anni started a video call"]]);
    expect(pushed.map((p) => p.member).sort()).toEqual(["lukky", "rishii"]);
    expect(pushed[0]).toMatchObject({ title: "Anni started a video call", url: "/group-chat" });
    for (const m of ["lukky", "rishii"] as MemberId[]) expect((await poll(m)).call.active?.startedBy).toBe("anni");
  });

  it("only one call at a time: a second start tells the caller to join the live one", async () => {
    await act("anni", { action: "start", media: "audio" });
    const second = await act("lukky", { action: "start", media: "video" });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("call_in_progress");
    expect(second.body.error.details.startedBy).toBe("anni");
  });

  it("routes offers and answers only to the addressee, never to the sender or the third member", async () => {
    const { body } = await act("anni", { action: "start", media: "audio" });
    const callId = body.data.call.callId;
    await act("lukky", { action: "join", callId });
    await act("lukky", { action: "ping", callId });
    expect((await act("anni", { action: "offer", callId, to: "lukky", payload: '{"type":"offer","sdp":"x"}' })).status).toBe(200);
    expect((await poll("lukky")).call.signals.map((s) => [s.type, s.from])).toEqual([["start", "anni"], ["offer", "anni"]]);
    expect((await poll("rishii")).call.signals.some((s) => s.type === "offer")).toBe(false);
    expect((await poll("anni")).call.signals.some((s) => s.type === "offer")).toBe(false); // not echoed to the sender
    await act("lukky", { action: "answer", callId, to: "anni", payload: '{"type":"answer","sdp":"y"}' });
    expect((await poll("anni")).call.signals.map((s) => s.type)).toContain("answer");
    expect((await poll("rishii")).call.signals.some((s) => s.type === "answer")).toBe(false);
  });

  it("returns only signals newer than the cursor", async () => {
    const { body } = await act("anni", { action: "start", media: "audio" });
    const callId = body.data.call.callId;
    await act("lukky", { action: "join", callId });
    const first = await poll("anni");
    expect(first.call.signals.map((s) => s.type)).toEqual(["join"]);
    const again = await poll("anni", first.call.cursor);
    expect(again.call.signals).toEqual([]);
  });

  it("validates actions: unknown call, missing target, oversize or malformed payloads, self-targeting", async () => {
    const { body } = await act("anni", { action: "start", media: "audio" });
    const callId = body.data.call.callId;
    expect((await act("lukky", { action: "join", callId: "call_unknown" })).status).toBe(409);
    expect((await act("lukky", { action: "offer", callId, payload: "x" })).status).toBe(400); // no `to`
    expect((await act("lukky", { action: "offer", callId, to: "lukky", payload: "x" })).status).toBe(400); // to self
    expect((await act("lukky", { action: "offer", callId, to: "anni" })).status).toBe(400); // no payload
    expect((await act("lukky", { action: "offer", callId, to: "anni", payload: "x".repeat(32_001) })).status).toBe(400);
    expect((await act("lukky", { action: "hack", callId })).status).toBe(400);
    expect((await act("lukky", { action: "join", callId, from: "anni" })).status).toBe(400); // sender is the session, never the body
  });

  it("the call ends when the last participant leaves, and a new one can then start", async () => {
    const { body } = await act("anni", { action: "start", media: "audio" });
    const callId = body.data.call.callId;
    await act("lukky", { action: "join", callId });
    await act("anni", { action: "leave", callId });
    expect((await poll("rishii")).call.active?.participants).toEqual(["lukky"]);
    await act("lukky", { action: "leave", callId });
    expect((await poll("rishii")).call.active).toBeNull();
    expect((await act("rishii", { action: "start", media: "audio" })).status).toBe(201);
  });

  it("a call whose participants stopped pinging (closed tab, lost network) is treated as over", () => {
    const t0 = Date.parse("2026-10-15T10:00:00.000Z");
    const sig = (type: CallSignal["type"], from: MemberId, at: number): CallSignal => ({ signalId: `sig_${type}${from}${at}`, callId: "call_1", from, type, payload: type === "start" ? '{"media":"audio"}' : "", createdAt: new Date(t0 + at).toISOString() });
    const log = [sig("start", "anni", 0), sig("join", "lukky", 1000)];
    expect(deriveActiveCall(log, new Date(t0 + 5_000))?.participants).toEqual(["anni", "lukky"]);
    expect(deriveActiveCall(log, new Date(t0 + PRESENCE_MS + 2_000))).toBeNull();
    const pinged = [...log, sig("ping", "lukky", 40_000)];
    expect(deriveActiveCall(pinged, new Date(t0 + PRESENCE_MS + 2_000))?.participants).toEqual(["lukky"]);
  });

  it("requires a session and the same origin", async () => {
    as(null);
    expect((await callRoute(post({ action: "start" }))).status).toBe(401);
    as("anni");
    expect((await callRoute(post({ action: "start" }, { origin: "https://evil.example" }))).status).toBe(403);
    expect(sheets.dataRows("CallSignals")).toHaveLength(0);
  });

  it("does not break the text chat when only the signalling tab is missing", async () => {
    await act("anni", { action: "start", media: "audio" });
    sheets.tabs.delete("CallSignals");
    const res = await poll("lukky");
    expect(res.call.active).toBeNull();
  });
});
