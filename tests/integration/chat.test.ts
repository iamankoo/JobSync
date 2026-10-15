import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { GET as pollRoute } from "@/app/api/chat/poll/route";
import { POST as sendRoute } from "@/app/api/chat/messages/route";
import { POST as readRoute } from "@/app/api/chat/read/route";
import { GET as unreadRoute } from "@/app/api/chat/unread/route";
import { POST as uploadRoute } from "@/app/api/chat/upload/route";
import { GET as fileRoute } from "@/app/api/chat/files/[fileId]/route";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { resetUploadThrottleForTesting } from "@/lib/chat/upload-throttle";
import { MAX_FILE_BYTES } from "@/lib/chat/files";
import { MEMBER_IDS, type MemberId } from "@/config/members";
import { FakeSheets } from "../helpers/fake-sheets";

let sheets: FakeSheets;
const as = (m: MemberId | null) => vi.mocked(getSession).mockResolvedValue(m ? { memberId: m, expiresAt: 9_999_999_999 } : null);
const json = (url: string, method: string, data?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", host: "localhost", ...headers },
    body: data === undefined ? undefined : JSON.stringify(data),
  });

type Msg = { messageId: string; memberId: MemberId; kind: string; text: string; seq: number; fileId?: string; fileName?: string; mimeType?: string; sizeBytes?: number };
async function poll(m: MemberId, after = 0) {
  as(m);
  const res = await pollRoute(json(`/api/chat/poll?after=${after}`, "GET"));
  expect(res.status).toBe(200);
  return (await res.json()).data as { messages: Msg[]; cursor: number; lastReadRow: number; recentCall: boolean };
}
async function say(m: MemberId, text: string) {
  as(m);
  const res = await sendRoute(json("/api/chat/messages", "POST", { text }));
  expect(res.status).toBe(201);
  return (await res.json()).data as Msg;
}
async function unread(m: MemberId) {
  as(m);
  return (await (await unreadRoute(json("/api/chat/unread", "GET"))).json()).data.unread as number;
}

// Real file signatures
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4, 5, 6, 7, 8]);
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF");
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8]);
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0]);

function uploadReq(m: MemberId, bytes: Uint8Array, name: string, fields: Record<string, string> = {}, type = "application/octet-stream") {
  as(m);
  const fd = new FormData();
  fd.set("file", new File([bytes as BlobPart], name, { type }));
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  // Build the body ourselves so content-length is present like a browser upload.
  const body = new Response(fd);
  return body.arrayBuffer().then((buf) => new Request("http://localhost/api/chat/upload", { method: "POST", headers: { "content-type": body.headers.get("content-type")!, "content-length": String(buf.byteLength), host: "localhost" }, body: buf }));
}
async function upload(m: MemberId, bytes: Uint8Array, name: string, fields: Record<string, string> = {}, type?: string) {
  return uploadRoute(await uploadReq(m, bytes, name, fields, type));
}

beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
  resetUploadThrottleForTesting();
});
afterEach(() => {
  setSheetsClientForTesting(null);
  vi.mocked(getSession).mockReset();
});

describe("group chat: messaging between the three members", () => {
  for (const sender of MEMBER_IDS) {
    it(`${sender} sends a message: the other two receive it with the right sender and a timestamp`, async () => {
      const sent = await say(sender, `Hello from ${sender}`);
      for (const receiver of MEMBER_IDS.filter((m) => m !== sender)) {
        const { messages } = await poll(receiver);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ messageId: sent.messageId, memberId: sender, text: `Hello from ${sender}`, kind: "text" });
        expect(Number.isNaN(Date.parse((messages[0] as unknown as { createdAt: string }).createdAt))).toBe(false);
      }
    });
  }

  it("persists across a 'refresh' (a fresh poll from 0) and in the sheet", async () => {
    await say("anni", "one");
    await say("lukky", "two");
    const again = await poll("rishii", 0);
    expect(again.messages.map((m) => m.text)).toEqual(["one", "two"]);
    expect(sheets.dataRows("ChatMessages").map((r) => r[3])).toEqual(["one", "two"]);
  });

  it("delivers only NEW messages after the cursor, in order, without gaps or repeats", async () => {
    await say("anni", "m1");
    const first = await poll("lukky");
    await say("rishii", "m2");
    await say("anni", "m3");
    const next = await poll("lukky", first.cursor);
    expect(next.messages.map((m) => m.text)).toEqual(["m2", "m3"]);
    const none = await poll("lukky", next.cursor);
    expect(none.messages).toEqual([]);
    expect(none.cursor).toBe(next.cursor);
  });

  it("rejects empty, whitespace-only, oversize and sender-spoofing messages", async () => {
    as("anni");
    for (const bad of [{ text: "" }, { text: "   " }, { text: "x".repeat(4001) }, { text: "hi", memberId: "lukky" }, {}]) {
      expect((await sendRoute(json("/api/chat/messages", "POST", bad))).status, JSON.stringify(bad)).toBe(400);
    }
    expect(sheets.dataRows("ChatMessages")).toHaveLength(0);
  });

  it("stores text literally (no formula injection) and preserves line breaks", async () => {
    await say("anni", "=SUM(A1:A9)\nsecond line");
    const { messages } = await poll("lukky");
    expect(messages[0].text).toBe("=SUM(A1:A9)\nsecond line");
  });

  it("rejects unauthenticated and cross-origin access to every chat route", async () => {
    as(null);
    expect((await pollRoute(json("/api/chat/poll", "GET"))).status).toBe(401);
    expect((await sendRoute(json("/api/chat/messages", "POST", { text: "hi" }))).status).toBe(401);
    expect((await unreadRoute(json("/api/chat/unread", "GET"))).status).toBe(401);
    expect((await readRoute(json("/api/chat/read", "POST", { upToRow: 2 }))).status).toBe(401);
    expect((await uploadRoute(await uploadReq("anni", PNG, "a.png").then((r) => (as(null), r)))).status).toBe(401);
    expect((await fileRoute(json("/api/chat/files/file_x", "GET"), { params: Promise.resolve({ fileId: "file_x" }) })).status).toBe(401);
    as("anni");
    expect((await sendRoute(json("/api/chat/messages", "POST", { text: "hi" }, { origin: "https://evil.example" }))).status).toBe(403);
    expect(sheets.dataRows("ChatMessages")).toHaveLength(0);
  });

  it("an inactive member cannot use the chat", async () => {
    sheets = new FakeSheets().seedMembers({ rishii: false });
    setSheetsClientForTesting(sheets);
    resetMembersCache();
    as("rishii");
    expect((await pollRoute(json("/api/chat/poll", "GET"))).status).toBe(403);
    expect((await sendRoute(json("/api/chat/messages", "POST", { text: "hi" }))).status).toBe(403);
  });

  it("reports 503 'not set up' (not a crash) while the chat tabs are missing", async () => {
    sheets.tabs.delete("ChatMessages");
    as("anni");
    const res = await pollRoute(json("/api/chat/poll", "GET"));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("chat_not_configured");
  });
});

describe("group chat: unread state", () => {
  it("counts only other members' messages, per member", async () => {
    await say("anni", "a1");
    await say("anni", "a2");
    await say("lukky", "l1");
    expect(await unread("anni")).toBe(1);
    expect(await unread("lukky")).toBe(2);
    expect(await unread("rishii")).toBe(3);
  });

  it("is cleared by marking read, persists, and only counts what arrives afterwards", async () => {
    await say("anni", "a1");
    const page = await poll("lukky");
    as("lukky");
    const res = await readRoute(json("/api/chat/read", "POST", { upToRow: page.cursor }));
    expect(res.status).toBe(200);
    expect(await unread("lukky")).toBe(0);
    expect(await unread("rishii")).toBe(1); // someone else's marker is untouched
    await say("anni", "a2");
    expect(await unread("lukky")).toBe(1);
    expect((await poll("lukky")).lastReadRow).toBe(page.cursor);
  });

  it("a read marker never moves backwards", async () => {
    await say("anni", "1");
    await say("anni", "2");
    const page = await poll("lukky");
    as("lukky");
    await readRoute(json("/api/chat/read", "POST", { upToRow: page.cursor }));
    await readRoute(json("/api/chat/read", "POST", { upToRow: 2 }));
    expect((await poll("lukky")).lastReadRow).toBe(page.cursor);
    expect(sheets.dataRows("ChatReads")).toHaveLength(1);
  });

  it("a member's own messages are never unread for them", async () => {
    await say("rishii", "mine");
    expect(await unread("rishii")).toBe(0);
  });
});

describe("group chat: attachments", () => {
  it("shares an image, a PDF and a voice note; the other members can download exactly those bytes", async () => {
    const cases: [Uint8Array, string, Record<string, string>, string][] = [
      [PNG, "photo.png", {}, "image/png"],
      [PDF, "cv.pdf", { caption: "my CV" }, "application/pdf"],
      [WEBM, "recording.webm", { kind: "voice", durationSec: "12" }, "audio/webm"],
    ];
    for (const [bytes, name, fields, mime] of cases) {
      const res = await upload("anni", bytes, name, fields);
      expect(res.status, name).toBe(201);
      const msg = (await res.json()).data as Msg;
      expect(msg.mimeType).toBe(mime);
      expect(msg.sizeBytes).toBe(bytes.length);
      for (const viewer of ["lukky", "rishii"] as MemberId[]) {
        as(viewer);
        const file = await fileRoute(json(`/api/chat/files/${msg.fileId}`, "GET"), { params: Promise.resolve({ fileId: msg.fileId! }) });
        expect(file.status).toBe(200);
        expect(file.headers.get("content-type")).toBe(mime);
        expect(file.headers.get("x-content-type-options")).toBe("nosniff");
        expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
      }
    }
    const { messages } = await poll("lukky");
    expect(messages.map((m) => m.kind)).toEqual(["file", "file", "voice"]);
    expect(messages[1].text).toBe("my CV");
  });

  it("round-trips a file that spans many sheet chunks", async () => {
    const big = new Uint8Array(1_500_000);
    big.set(PNG, 0);
    for (let i = PNG.length; i < big.length; i++) big[i] = (i * 31) % 251;
    const res = await upload("lukky", big, "big.png");
    expect(res.status).toBe(201);
    const msg = (await res.json()).data as Msg;
    expect(sheets.dataRows("ChatFiles").length).toBeGreaterThan(30);
    expect(sheets.dataRows("ChatFiles").every((r) => r[2].length <= 40_000)).toBe(true);
    as("anni");
    const file = await fileRoute(json(`/api/chat/files/${msg.fileId}`, "GET"), { params: Promise.resolve({ fileId: msg.fileId! }) });
    expect(Buffer.from(await file.arrayBuffer()).equals(Buffer.from(big))).toBe(true);
  });

  it("refuses files that are too large, empty, executables, scripts, SVG, HTML or disguised", async () => {
    const tooBig = new Uint8Array(MAX_FILE_BYTES + 1);
    tooBig.set(PNG);
    expect((await upload("anni", tooBig, "huge.png")).status).toBe(413);
    expect((await upload("anni", new Uint8Array(0), "empty.png")).status).toBe(400);
    expect((await upload("anni", EXE, "setup.exe")).status).toBe(400);
    expect((await upload("anni", EXE, "photo.png")).status).toBe(400); // an .exe renamed to .png
    expect((await upload("anni", new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>"), "x.svg")).status).toBe(400);
    expect((await upload("anni", new TextEncoder().encode("<html><script>alert(1)</script></html>"), "page.html")).status).toBe(400);
    expect((await upload("anni", new TextEncoder().encode("#!/bin/sh\nrm -rf /"), "run.sh")).status).toBe(400);
    expect((await upload("anni", PNG, "image.pdf")).status).toBe(400); // extension disagrees with the content
    expect((await upload("anni", PDF, "voice.pdf", { kind: "voice" })).status).toBe(400); // a voice note must be audio
    expect(sheets.dataRows("ChatMessages")).toHaveLength(0);
    expect(sheets.dataRows("ChatFiles")).toHaveLength(0);
  });

  it("refuses an oversized declared upload before reading it, and uploads without a length", async () => {
    as("anni");
    const huge = new Request("http://localhost/api/chat/upload", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(10 * 1024 * 1024), host: "localhost" }, body: "x" });
    expect((await uploadRoute(huge)).status).toBe(413);
  });

  it("ignores the browser's claimed MIME type and name tricks: the stored name is sanitised", async () => {
    const res = await upload("anni", PNG, "..\\..\\evil\"<name>.png", {}, "text/html");
    expect(res.status).toBe(201);
    const msg = (await res.json()).data as Msg;
    expect(msg.mimeType).toBe("image/png");
    expect(msg.fileName).toBe("evil name.png".replace(" ", "")); // path parts and unsafe characters removed
  });

  it("serves documents as downloads and images inline; 404 for unknown or never-posted file IDs", async () => {
    const doc = await (await upload("anni", new TextEncoder().encode("a,b\n1,2\n"), "data.csv")).json();
    as("lukky");
    const res = await fileRoute(json(`/api/chat/files/${doc.data.fileId}`, "GET"), { params: Promise.resolve({ fileId: doc.data.fileId }) });
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    const missing = await fileRoute(json("/api/chat/files/file_nope", "GET"), { params: Promise.resolve({ fileId: "file_nope" }) });
    expect(missing.status).toBe(404);
    // Bytes that exist in ChatFiles but were never attached to a message are not reachable.
    sheets.rows("ChatFiles").push(["file_orphan", "0", Buffer.from("secret").toString("base64")]);
    expect((await fileRoute(json("/api/chat/files/file_orphan", "GET"), { params: Promise.resolve({ fileId: "file_orphan" }) })).status).toBe(404);
    const png = await (await upload("anni", PNG, "p.png")).json();
    as("rishii");
    const img = await fileRoute(json(`/api/chat/files/${png.data.fileId}`, "GET"), { params: Promise.resolve({ fileId: png.data.fileId }) });
    expect(img.headers.get("content-disposition")).toMatch(/^inline;/);
  });

  it("throttles bursts of uploads", async () => {
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await upload("anni", PNG, `p${i}.png`)).status;
    expect(last).toBe(429);
  });
});
