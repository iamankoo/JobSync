import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { POST as postConnection } from "@/app/api/connections/route";
import { DELETE as deleteConnection, PUT as putConnection } from "@/app/api/connections/[connectionId]/route";
import { POST as postMessage } from "@/app/api/chat/messages/route";
import { POST as postRead } from "@/app/api/chat/read/route";
import { POST as postSub } from "@/app/api/push/subscriptions/route";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { sendAttachmentMessage, sendCallMessage } from "@/lib/google-sheets/chat-service";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { resetPushDedupeForTesting, setPushSenderForTesting, type PushSender } from "@/lib/push/notify";
import type { MemberId } from "@/config/members";
import { FakeSheets, googleError } from "../helpers/fake-sheets";

const MEMBERS: MemberId[] = ["anni", "lukky", "rishii"];
const NAME: Record<MemberId, string> = { anni: "Anni", lukky: "Lukky", rishii: "Rishii" };

let sheets: FakeSheets;
let sent: { member: MemberId; payload: { title: string; body: string; url: string; tag: string; icon?: string } }[];
let sender: ReturnType<typeof vi.fn<PushSender>>;

const as = (m: MemberId) => vi.mocked(getSession).mockResolvedValue({ memberId: m, expiresAt: 9_999_999_999 });
const req = (url: string, method: string, data?: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json", host: "localhost" }, body: data === undefined ? undefined : JSON.stringify(data) });
const recipients = () => sent.map((s) => s.member).sort();
const others = (actor: MemberId) => MEMBERS.filter((m) => m !== actor).sort();

async function subscribeAll() {
  for (const m of MEMBERS) {
    as(m);
    const res = await postSub(req("/api/push/subscriptions", "POST", { endpoint: `https://fcm.googleapis.com/fcm/send/${m}-1`, keys: { p256dh: "BPk1234567890abcd", auth: "auth1234567890" } }));
    expect(res.status).toBeLessThan(300);
  }
}
const addConnection = (m: MemberId, body: Record<string, unknown>) => {
  as(m);
  return postConnection(req("/api/connections", "POST", body));
};
const say = (m: MemberId, text: string) => {
  as(m);
  return postMessage(req("/api/chat/messages", "POST", { text }));
};

beforeEach(async () => {
  vi.stubEnv("VAPID_PUBLIC_KEY", "test-public-key");
  vi.stubEnv("VAPID_PRIVATE_KEY", "test-private-key");
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
  resetPushDedupeForTesting();
  sent = [];
  sender = vi.fn<PushSender>(async (sub, payload) => {
    sent.push({ member: sub.memberId, payload });
    return { ok: true };
  });
  setPushSenderForTesting(sender);
  await subscribeAll();
  sent = [];
  sender.mockClear();
});
afterEach(() => {
  setSheetsClientForTesting(null);
  setPushSenderForTesting(null);
  vi.mocked(getSession).mockReset();
  vi.unstubAllEnvs();
});

describe("new connection notifications", () => {
  for (const actor of MEMBERS) {
    it(`${NAME[actor]} adds a connection: only the other members are notified, with person and company`, async () => {
      const res = await addConnection(actor, { name: "Priya Sharma", company: "Acme Corp", role: "Engineering Manager", message: "PRIVATE-MESSAGE", notes: "PRIVATE-NOTES" });
      expect(res.status).toBe(201);
      expect(recipients()).toEqual(others(actor));
      const { data } = await res.json();
      for (const s of sent) {
        expect(s.payload.title).toBe(`${NAME[actor]} added a connection: Priya Sharma`);
        expect(s.payload.body).toBe("Engineering Manager · Acme Corp — tap to view in Connections.");
        expect(s.payload.url).toBe("/connections");
        expect(s.payload.tag).toBe(`connection-added-${data.connectionId}`);
        // the saved message and notes never leave in a notification
        expect(JSON.stringify(s.payload)).not.toMatch(/PRIVATE/);
      }
    });
  }

  it("works for a person with no company or role", async () => {
    await addConnection("anni", { name: "Rahul" });
    expect(sent[0].payload.body).toBe("tap to view in Connections.");
  });

  it("editing, changing status or deleting a connection sends nothing", async () => {
    const { data } = await (await addConnection("anni", { name: "Priya" })).json();
    sent = [];
    sender.mockClear();
    as("anni");
    const params = { params: Promise.resolve({ connectionId: data.connectionId }) };
    expect((await putConnection(req(`/api/connections/${data.connectionId}`, "PUT", { status: "Connected", company: "New Co" }), params)).status).toBe(200);
    expect((await deleteConnection(req(`/api/connections/${data.connectionId}`, "DELETE"), params)).status).toBe(200);
    expect(sender).not.toHaveBeenCalled();
  });

  it("sends nothing when the save fails or the input is invalid", async () => {
    sheets.failNext = { op: "append", error: googleError(500) };
    expect((await addConnection("anni", { name: "Priya" })).status).toBeGreaterThanOrEqual(400);
    expect((await addConnection("anni", { name: "" })).status).toBe(400);
    expect(sheets.dataRows("Connections")).toHaveLength(0);
    expect(sender).not.toHaveBeenCalled();
  });

  it("keeps the connection saved when push delivery fails", async () => {
    sender.mockRejectedValue(new Error("push service down"));
    expect((await addConnection("anni", { name: "Priya" })).status).toBe(201);
    expect(sheets.dataRows("Connections")).toHaveLength(1);
  });
});

describe("Group Chat message notifications", () => {
  for (const actor of MEMBERS) {
    it(`${NAME[actor]} sends a message: the other members are told who sent it; the sender is not notified`, async () => {
      expect((await say(actor, "Interview prep at 6?")).status).toBe(201);
      expect(recipients()).toEqual(others(actor));
      expect(sent.some((s) => s.member === actor)).toBe(false);
      for (const s of sent) {
        expect(s.payload.title).toBe(`New Group Chat message from ${NAME[actor]}`);
        expect(s.payload.body).toBe("Interview prep at 6?");
        expect(s.payload.url).toBe("/group-chat");
        expect(s.payload.tag).toBe(`chat-${actor}`);
      }
    });
  }

  it("every message notifies once (no duplicates, nothing dropped)", async () => {
    await say("anni", "one");
    await say("anni", "two");
    await say("lukky", "three");
    expect(sent.filter((s) => s.member === "rishii").map((s) => s.payload.body)).toEqual(["one", "two", "three"]);
    expect(sent.filter((s) => s.member === "anni").map((s) => s.payload.body)).toEqual(["three"]);
    expect(sent.filter((s) => s.member === "lukky").map((s) => s.payload.body)).toEqual(["one", "two"]);
  });

  it("long messages are shortened in the notification", async () => {
    await say("anni", "x".repeat(1000));
    expect(sent[0].payload.body.length).toBeLessThanOrEqual(140);
  });

  it("files and voice notes are announced as such", async () => {
    await sendAttachmentMessage("anni", { kind: "file", fileId: "file_1", fileName: "resume.pdf", mimeType: "application/pdf", sizeBytes: 10 });
    await sendAttachmentMessage("anni", { kind: "voice", fileId: "file_2", fileName: "voice-note.webm", mimeType: "audio/webm", sizeBytes: 10, durationSec: 4 });
    await sendAttachmentMessage("anni", { kind: "file", fileId: "file_3", fileName: "a.png", mimeType: "image/png", sizeBytes: 10, text: "look at this" });
    const bodies = sent.filter((s) => s.member === "lukky").map((s) => s.payload.body);
    expect(bodies).toEqual(["📎 resume.pdf", "🎤 Voice note", "📎 look at this"]);
  });

  it("call lines in the chat do not add a second notification (calls already notify on their own)", async () => {
    await sendCallMessage("anni", "call_1", "Anni started a video call");
    expect(sender).not.toHaveBeenCalled();
  });

  it("marking messages as read sends nothing", async () => {
    await say("anni", "hello");
    sent = [];
    sender.mockClear();
    as("lukky");
    expect((await postRead(req("/api/chat/read", "POST", { upToRow: 2 }))).status).toBe(200);
    expect(sender).not.toHaveBeenCalled();
  });

  it("sends nothing when the message could not be saved", async () => {
    sheets.failNext = { op: "append", error: googleError(500) };
    expect((await say("anni", "hello")).status).toBeGreaterThanOrEqual(400);
    expect(sender).not.toHaveBeenCalled();
  });

  it("the message is still delivered to the chat when push fails", async () => {
    sender.mockRejectedValue(new Error("push service down"));
    expect((await say("anni", "hello")).status).toBe(201);
    expect(sheets.dataRows("ChatMessages")).toHaveLength(1);
  });

  it("without push configured (no VAPID keys) chat works exactly as before", async () => {
    vi.unstubAllEnvs();
    expect((await say("anni", "hello")).status).toBe(201);
    expect(sender).not.toHaveBeenCalled();
  });
});
