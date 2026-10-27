/**
 * Profile uploads: resumes (max 10, own only) and the professional photo (upload, replace, persistence).
 * Bytes go to the existing file store (ChatFiles chunks), metadata to MemberFiles. In-memory sheet only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/session")>()), getSession: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { GET as listRoute, POST as uploadRoute } from "@/app/api/profile/resumes/route";
import { DELETE as deleteRoute, GET as openRoute } from "@/app/api/profile/resumes/[recordId]/route";
import { POST as photoRoute } from "@/app/api/profile/photo/route";
import { GET as memberPhotoRoute } from "@/app/api/members/[memberId]/photo/route";
import { GET as chatFileRoute } from "@/app/api/chat/files/[fileId]/route";
import type { MemberId } from "@/config/members";
import { resetUploadThrottleForTesting } from "@/lib/chat/upload-throttle";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { photoVersions } from "@/lib/google-sheets/member-files-service";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { invalidateTableCache } from "@/lib/google-sheets/table";
import { FakeSheets } from "../helpers/fake-sheets";
import { unlockedCookie } from "../helpers/profile-unlock";

let sheets: FakeSheets;
const as = (m: MemberId | null) => vi.mocked(getSession).mockResolvedValue(m ? { memberId: m, expiresAt: 9_999_999_999 } : null);

const pdf = (tag: string) => new TextEncoder().encode(`%PDF-1.4\n% ${tag}\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF`);
const DOCX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 8, 0, 1, 2, 3, 4]);
const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, n, n, n, n]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3]);
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0]);

async function multipart(url: string, bytes: Uint8Array, name: string, member: MemberId) {
  const fd = new FormData();
  fd.set("file", new File([bytes as BlobPart], name, { type: "application/octet-stream" }));
  const body = new Response(fd);
  const buf = await body.arrayBuffer();
  return new Request(url, { method: "POST", headers: { "content-type": body.headers.get("content-type")!, "content-length": String(buf.byteLength), host: "localhost", origin: "http://localhost", cookie: await unlockedCookie(member) }, body: buf });
}
const upload = async (m: MemberId, bytes: Uint8Array, name: string) => {
  as(m);
  return uploadRoute(await multipart("http://localhost/api/profile/resumes", bytes, name, m));
};
const setPhoto = async (m: MemberId, bytes: Uint8Array, name: string) => {
  as(m);
  return photoRoute(await multipart("http://localhost/api/profile/photo", bytes, name, m));
};
const list = async (m: MemberId) => {
  as(m);
  return (await (await listRoute(new Request("http://localhost/api/profile/resumes", { headers: { cookie: await unlockedCookie(m) } }))).json()).data as { recordId: string; fileName: string; mimeType: string; sizeBytes: number; uploadedAt: string }[];
};
const open = async (m: MemberId, id: string, q = "") => {
  const cookie = await unlockedCookie(m);
  as(m);
  return openRoute(new Request(`http://localhost/api/profile/resumes/${id}${q}`, { headers: { cookie } }), { params: Promise.resolve({ recordId: id }) });
};
const del = async (m: MemberId, id: string) => {
  const cookie = await unlockedCookie(m);
  as(m);
  return deleteRoute(new Request(`http://localhost/api/profile/resumes/${id}`, { method: "DELETE", headers: { host: "localhost", origin: "http://localhost", cookie } }), { params: Promise.resolve({ recordId: id }) });
};
const photoOf = (viewer: MemberId, of: string) => {
  as(viewer);
  return memberPhotoRoute(new Request(`http://localhost/api/members/${of}/photo`), { params: Promise.resolve({ memberId: of }) });
};

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

describe("resumes", () => {
  it("uploads a PDF and a DOCX, listed newest first with metadata (no internal file IDs)", async () => {
    const a = await upload("anni", pdf("one"), "Anni CV.pdf");
    expect(a.status).toBe(201);
    const b = await upload("anni", DOCX, "Anni CV.docx");
    expect(b.status).toBe(201);
    const mine = await list("anni");
    expect(mine.map((r) => r.fileName).sort()).toEqual(["Anni CV.docx", "Anni CV.pdf"]);
    expect(mine.find((r) => r.fileName === "Anni CV.pdf")).toMatchObject({ mimeType: "application/pdf", sizeBytes: pdf("one").length });
    expect(JSON.stringify(mine)).not.toMatch(/file_/);
    // Metadata row tied to the member; bytes in the existing file store.
    expect(sheets.dataRows("MemberFiles").every((r) => r[1] === "anni" && r[2] === "resume")).toBe(true);
    expect(sheets.dataRows("ChatFiles").length).toBeGreaterThanOrEqual(2);
  });

  it("allows 10 resumes and rejects the 11th on the server", async () => {
    for (let i = 0; i < 10; i++) expect((await upload("lukky", pdf(`n${i}`), `cv-${i}.pdf`)).status).toBe(201);
    resetUploadThrottleForTesting();
    const eleventh = await upload("lukky", pdf("n10"), "cv-10.pdf");
    expect(eleventh.status).toBe(409);
    expect((await eleventh.json()).error.code).toBe("resume_limit");
    expect(await list("lukky")).toHaveLength(10);
    // Another member's limit is independent.
    expect((await upload("rishii", pdf("r"), "r.pdf")).status).toBe(201);
  });

  it("lists only the signed-in member's resumes", async () => {
    await upload("anni", pdf("a"), "anni.pdf");
    await upload("lukky", pdf("l"), "lukky.pdf");
    expect((await list("anni")).map((r) => r.fileName)).toEqual(["anni.pdf"]);
    expect((await list("lukky")).map((r) => r.fileName)).toEqual(["lukky.pdf"]);
    expect(await list("rishii")).toEqual([]);
  });

  it("opens a PDF inline and downloads on request, returning the exact bytes", async () => {
    await upload("anni", pdf("open-me"), "CV.pdf");
    const [r] = await list("anni");
    const res = await open("anni", r.recordId);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^inline; filename="CV.pdf"/);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(pdf("open-me"));
    expect((await open("anni", r.recordId, "?download=1")).headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("deletes a resume: record and stored bytes are gone", async () => {
    await upload("anni", pdf("x"), "x.pdf");
    await upload("anni", pdf("y"), "y.pdf");
    const before = sheets.dataRows("ChatFiles").length;
    const x = (await list("anni")).find((r) => r.fileName === "x.pdf")!;
    const res = await del("anni", x.recordId);
    expect(res.status).toBe(200);
    expect((await list("anni")).map((r) => r.fileName)).toEqual(["y.pdf"]);
    expect(sheets.dataRows("ChatFiles").length).toBeLessThan(before);
    expect((await open("anni", x.recordId)).status).toBe(404);
  });

  it("another member cannot list, open or delete my resume (answers like a missing file)", async () => {
    await upload("anni", pdf("secret"), "private.pdf");
    const [r] = await list("anni");
    const peek = await open("lukky", r.recordId);
    expect(peek.status).toBe(404);
    expect(await peek.text()).not.toContain("%PDF");
    expect((await del("rishii", r.recordId)).status).toBe(404);
    expect(await list("anni")).toHaveLength(1);
    // The resume's bytes are not reachable through the chat attachment route either.
    const fileId = sheets.dataRows("MemberFiles")[0][3];
    as("lukky");
    const viaChat = await chatFileRoute(new Request(`http://localhost/api/chat/files/${fileId}`), { params: Promise.resolve({ fileId }) });
    expect(viaChat.status).toBe(404);
  });

  it("rejects wrong types (by content), and requires a session", async () => {
    const exe = await upload("anni", EXE, "cv.pdf");
    expect(exe.status).toBe(400);
    expect((await exe.json()).error.code).toBe("file_type_not_allowed");
    expect((await upload("anni", png(1), "photo.png")).status).toBe(400); // images are not resumes
    as(null);
    expect((await listRoute(new Request("http://localhost/api/profile/resumes"))).status).toBe(401);
  });

  it("rejects files over 2 MB", async () => {
    const big = new Uint8Array(2 * 1024 * 1024 + 10);
    big.set(pdf("big"));
    expect((await upload("anni", big, "big.pdf")).status).toBe(413);
  });

  it("says uploads are not set up when the MemberFiles tab is missing", async () => {
    sheets.tabs.delete("MemberFiles");
    const res = await upload("anni", pdf("a"), "a.pdf");
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("member_files_unavailable");
  });
});

describe("professional photo", () => {
  it("uploads a photo that any signed-in teammate's avatar can show", async () => {
    expect((await photoOf("lukky", "anni")).status).toBe(404); // none yet: built-in photo is used
    const res = await setPhoto("anni", png(7), "me.png");
    expect(res.status).toBe(201);
    const shown = await photoOf("lukky", "anni");
    expect(shown.status).toBe(200);
    expect(shown.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await shown.arrayBuffer())).toEqual(png(7));
    expect(Object.keys(await photoVersions())).toEqual(["anni"]);
  });

  it("replaces the photo: one record, new version, old bytes removed", async () => {
    await setPhoto("anni", png(1), "first.png");
    const v1 = (await photoVersions()).anni;
    const chunksAfterFirst = sheets.dataRows("ChatFiles").length;
    const res = await setPhoto("anni", JPEG, "second.jpg");
    expect(res.status).toBe(201);
    const v2 = (await photoVersions()).anni;
    expect(v2).not.toBe(v1);
    expect(sheets.dataRows("MemberFiles").filter((r) => r[1] === "anni" && r[2] === "photo")).toHaveLength(1);
    expect(sheets.dataRows("ChatFiles").length).toBe(chunksAfterFirst);
    expect(sheets.dataRows("ChatFiles").some((r) => r[0] === v1)).toBe(false);
    const shown = await photoOf("rishii", "anni");
    expect(shown.headers.get("content-type")).toBe("image/jpeg");
  });

  it("persists across sessions/devices (stored in the sheet, read back fresh)", async () => {
    await setPhoto("rishii", png(3), "r.png");
    invalidateTableCache();
    resetMembersCache();
    expect((await photoVersions()).rishii).toBeTruthy();
    expect(new Uint8Array(await (await photoOf("rishii", "rishii")).arrayBuffer())).toEqual(png(3));
  });

  it("a member can only set their OWN photo; the body cannot target someone else", async () => {
    as("lukky");
    const fd = new FormData();
    fd.set("file", new File([png(9) as BlobPart], "x.png"));
    fd.set("memberId", "anni");
    const body = new Response(fd);
    const buf = await body.arrayBuffer();
    await photoRoute(new Request("http://localhost/api/profile/photo", { method: "POST", headers: { "content-type": body.headers.get("content-type")!, "content-length": String(buf.byteLength), host: "localhost", origin: "http://localhost", cookie: await unlockedCookie("lukky") }, body: buf }));
    const v = await photoVersions();
    expect(v.anni).toBeUndefined();
    expect(v.lukky).toBeTruthy();
  });

  it("rejects non-images and requires a session to view", async () => {
    expect((await setPhoto("anni", pdf("x"), "x.pdf")).status).toBe(400);
    expect((await setPhoto("anni", EXE, "x.png")).status).toBe(400);
    await setPhoto("anni", png(2), "ok.png");
    as(null);
    expect((await memberPhotoRoute(new Request("http://localhost/api/members/anni/photo"), { params: Promise.resolve({ memberId: "anni" }) })).status).toBe(401);
  });
});
