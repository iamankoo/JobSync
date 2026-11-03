/**
 * Renaming an uploaded PDF: metadata only. In-memory sheet; no real file store, mailbox or production data.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/session")>()), getSession: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { GET as listRoute, POST as uploadRoute } from "@/app/api/profile/resumes/route";
import { DELETE as deleteRoute, GET as openRoute, PATCH as renameRoute } from "@/app/api/profile/resumes/[recordId]/route";
import type { MemberId } from "@/config/members";
import { resetUploadThrottleForTesting } from "@/lib/chat/upload-throttle";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { invalidateTableCache } from "@/lib/google-sheets/table";
import { FakeSheets } from "../helpers/fake-sheets";
import { unlockedCookie } from "../helpers/profile-unlock";

let sheets: FakeSheets;
const as = (m: MemberId | null) => vi.mocked(getSession).mockResolvedValue(m ? { memberId: m, expiresAt: 9_999_999_999 } : null);
const pdf = (tag: string) => new TextEncoder().encode(`%PDF-1.4\n% ${tag}\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF`);
const DOCX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 8, 0, 1, 2, 3, 4]);

async function upload(m: MemberId, bytes: Uint8Array, name: string) {
  as(m);
  const fd = new FormData();
  fd.set("file", new File([bytes as BlobPart], name, { type: "application/octet-stream" }));
  const body = new Response(fd);
  const buf = await body.arrayBuffer();
  const res = await uploadRoute(new Request("http://localhost/api/profile/resumes", { method: "POST", headers: { "content-type": body.headers.get("content-type")!, "content-length": String(buf.byteLength), host: "localhost", origin: "http://localhost", cookie: await unlockedCookie(m) }, body: buf }));
  expect(res.status).toBe(201);
  return (await res.json()).data as { recordId: string; fileName: string };
}
const list = async (m: MemberId) => {
  as(m);
  return (await (await listRoute(new Request("http://localhost/api/profile/resumes", { headers: { cookie: await unlockedCookie(m) } }))).json()).data as { recordId: string; fileName: string }[];
};
const ctx = (id: string) => ({ params: Promise.resolve({ recordId: id }) });
async function rename(m: MemberId | null, id: string, body: unknown, extra: Record<string, string> = {}) {
  if (m) as(m);
  else as(null);
  return renameRoute(new Request(`http://localhost/api/profile/resumes/${id}`, { method: "PATCH", headers: { "content-type": "application/json", host: "localhost", origin: "http://localhost", ...(m ? { cookie: await unlockedCookie(m) } : {}), ...extra }, body: JSON.stringify(body) }), ctx(id));
}
async function open(m: MemberId, id: string, q = "") {
  const cookie = await unlockedCookie(m);
  as(m);
  return openRoute(new Request(`http://localhost/api/profile/resumes/${id}${q}`, { headers: { cookie } }), ctx(id));
}
const rows = () => sheets.dataRows("MemberFiles");

beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
  resetUploadThrottleForTesting();
  invalidateTableCache();
});
afterEach(() => {
  setSheetsClientForTesting(null);
  vi.mocked(getSession).mockReset();
});

describe("PDF rename", () => {
  it("changes only the displayed name: id, storage reference, size, type, owner and bytes stay", async () => {
    const a = await upload("anni", pdf("one"), "Anni CV.pdf");
    const before = rows()[0].slice();
    const res = await rename("anni", a.recordId, { fileName: "  Anni SDE Resume  " });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ recordId: a.recordId, fileName: "Anni SDE Resume.pdf" });
    const after = rows()[0];
    // columns: recordId, member, kind, fileId (storage reference), fileName, mime, size, uploadedAt
    expect(after.filter((_, i) => i !== 4)).toEqual(before.filter((_, i) => i !== 4));
    expect(after[4]).toBe("Anni SDE Resume.pdf");
    expect(rows()).toHaveLength(1);
    expect((await list("anni"))[0].fileName).toBe("Anni SDE Resume.pdf");
  });

  it("keeps .pdf automatically and never doubles it", async () => {
    const a = await upload("anni", pdf("one"), "x.pdf");
    expect((await (await rename("anni", a.recordId, { fileName: "Resume 2027" })).json()).data.fileName).toBe("Resume 2027.pdf");
    expect((await (await rename("anni", a.recordId, { fileName: "Final.PDF" })).json()).data.fileName).toBe("Final.pdf");
    expect((await (await rename("anni", a.recordId, { fileName: "v3.pdf.pdf" })).json()).data.fileName).toBe("v3.pdf.pdf".replace(/\.pdf$/i, "") + ".pdf");
  });

  it("rejects empty, whitespace-only, invalid-character and over-long names and changes nothing", async () => {
    const a = await upload("anni", pdf("one"), "Keep.pdf");
    for (const fileName of ["", "   ", ".pdf", "a/b", "a\\b", "bad:name", 'q"uote', "what?", "star*", "pipe|x", "lt<gt>", "ctl\u0001x", "trailing.", "CON", "x".repeat(120)]) {
      const res = await rename("anni", a.recordId, { fileName });
      expect(res.status, JSON.stringify(fileName)).toBe(400);
      expect((await res.json()).error.message).toBeTruthy();
    }
    expect(rows()[0][4]).toBe("Keep.pdf");
  });

  it("rejects a duplicate of another of the member's resumes (case-insensitive) but allows the same name on another member", async () => {
    await upload("anni", pdf("one"), "First.pdf");
    const b = await upload("anni", pdf("two"), "Second.pdf");
    const clash = await rename("anni", b.recordId, { fileName: "first" });
    expect(clash.status).toBe(409);
    expect((await clash.json()).error.code).toBe("resume_name_taken");
    const other = await upload("lukky", pdf("three"), "Lukky.pdf");
    expect((await rename("lukky", other.recordId, { fileName: "First" })).status).toBe(200);
    // renaming to its own current name is a no-op, not a clash
    expect((await rename("anni", b.recordId, { fileName: "Second" })).status).toBe(200);
  });

  it("enforces ownership server-side: another member's record answers like a missing one; no session is refused", async () => {
    const a = await upload("anni", pdf("one"), "Anni.pdf");
    const stolen = await rename("lukky", a.recordId, { fileName: "Mine now" });
    expect(stolen.status).toBe(404);
    expect(rows()[0][4]).toBe("Anni.pdf");
    expect((await rename(null, a.recordId, { fileName: "x" })).status).toBe(401);
    expect((await rename("anni", a.recordId, { fileName: "x" }, { origin: "https://evil.example" })).status).toBe(403);
    // a body cannot smuggle other fields (member, file id, ...)
    expect((await rename("anni", a.recordId, { fileName: "ok", memberId: "lukky", fileId: "file_x" })).status).toBe(400);
    expect(rows()[0].slice(0, 4)).toEqual([a.recordId, "anni", "resume", rows()[0][3]]);
  });

  it("does not rename a Word resume (PDF only)", async () => {
    const d = await upload("anni", DOCX, "Anni.docx");
    const res = await rename("anni", d.recordId, { fileName: "Renamed" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("resume_not_pdf");
    expect(rows()[0][4]).toBe("Anni.docx");
  });

  it("preview, download and delete still work after a rename, with identical bytes", async () => {
    const bytes = pdf("original bytes");
    const a = await upload("anni", bytes, "Old.pdf");
    await rename("anni", a.recordId, { fileName: "New Name" });
    const view = await open("anni", a.recordId);
    expect(view.status).toBe(200);
    expect(view.headers.get("content-type")).toBe("application/pdf");
    expect(view.headers.get("content-disposition")).toContain("inline");
    expect(view.headers.get("content-disposition")).toContain("New Name.pdf");
    expect(new Uint8Array(await view.arrayBuffer())).toEqual(bytes);
    const dl = await open("anni", a.recordId, "?download=1");
    expect(dl.headers.get("content-disposition")).toContain("attachment");
    expect(dl.headers.get("content-disposition")).toContain("New Name.pdf");
    as("anni");
    const del = await deleteRoute(new Request(`http://localhost/api/profile/resumes/${a.recordId}`, { method: "DELETE", headers: { host: "localhost", origin: "http://localhost", cookie: await unlockedCookie("anni") } }), ctx(a.recordId));
    expect(del.status).toBe(200);
    expect(rows()).toHaveLength(0);
  });
});
