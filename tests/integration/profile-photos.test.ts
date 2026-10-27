/**
 * Profile → Photos: each member's PRIVATE photo library, separate from the professional photo (avatar).
 * Stored in MemberFiles with its own Kind ("library_photo"); bytes in the existing file store. Same Profile Lock and
 * ownership rules as resumes. In-memory sheet only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/session")>()), getSession: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { GET as listRoute, POST as uploadRoute } from "@/app/api/profile/photos/route";
import { DELETE as deleteRoute, GET as openRoute } from "@/app/api/profile/photos/[recordId]/route";
import { POST as avatarRoute } from "@/app/api/profile/photo/route";
import { GET as memberPhotoRoute } from "@/app/api/members/[memberId]/photo/route";
import { GET as resumesRoute, POST as resumeUploadRoute } from "@/app/api/profile/resumes/route";
import { POST as unlockRoute } from "@/app/api/profile/unlock/route";
import type { MemberId } from "@/config/members";
import { resetUploadThrottleForTesting } from "@/lib/chat/upload-throttle";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { photoVersions } from "@/lib/google-sheets/member-files-service";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { invalidateTableCache } from "@/lib/google-sheets/table";
import { FakeSheets } from "../helpers/fake-sheets";
import { TEST_PROFILE_PASSWORD, unlockedCookie } from "../helpers/profile-unlock";

let sheets: FakeSheets;
const as = (m: MemberId | null) => vi.mocked(getSession).mockResolvedValue(m ? { memberId: m, expiresAt: 9_999_999_999 } : null);
const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, n, n, n, n]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3]);
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF");
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0]);

async function multipart(url: string, bytes: Uint8Array, name: string, cookie?: string) {
  const fd = new FormData();
  fd.set("file", new File([bytes as BlobPart], name, { type: "application/octet-stream" }));
  const body = new Response(fd);
  const buf = await body.arrayBuffer();
  return new Request(url, { method: "POST", headers: { "content-type": body.headers.get("content-type")!, "content-length": String(buf.byteLength), host: "localhost", origin: "http://localhost", ...(cookie ? { cookie } : {}) }, body: buf });
}
type Info = { recordId: string; fileName: string; mimeType: string; sizeBytes: number; uploadedAt: string };
const add = async (m: MemberId, bytes: Uint8Array, name: string) => {
  const cookie = await unlockedCookie(m);
  as(m);
  return uploadRoute(await multipart("http://localhost/api/profile/photos", bytes, name, cookie));
};
const list = async (m: MemberId) => {
  const cookie = await unlockedCookie(m);
  as(m);
  return (await (await listRoute(new Request("http://localhost/api/profile/photos", { headers: { cookie } }))).json()).data as Info[];
};
const open = async (m: MemberId, id: string, q = "", cookie?: string) => {
  const c = cookie ?? (await unlockedCookie(m));
  as(m);
  return openRoute(new Request(`http://localhost/api/profile/photos/${id}${q}`, { headers: { cookie: c } }), { params: Promise.resolve({ recordId: id }) });
};
const del = async (m: MemberId, id: string, cookie?: string) => {
  const c = cookie ?? (await unlockedCookie(m));
  as(m);
  return deleteRoute(new Request(`http://localhost/api/profile/photos/${id}`, { method: "DELETE", headers: { host: "localhost", origin: "http://localhost", cookie: c } }), { params: Promise.resolve({ recordId: id }) });
};
const setAvatar = async (m: MemberId, bytes: Uint8Array, name: string) => {
  const cookie = await unlockedCookie(m);
  as(m);
  return avatarRoute(await multipart("http://localhost/api/profile/photo", bytes, name, cookie));
};
const avatarBytes = async (of: MemberId) => {
  as("rishii");
  const res = await memberPhotoRoute(new Request(`http://localhost/api/members/${of}/photo`), { params: Promise.resolve({ memberId: of }) });
  return res.status === 200 ? new Uint8Array(await res.arrayBuffer()) : res.status;
};
const kinds = () => sheets.dataRows("MemberFiles").map((r) => [r[1], r[2]]);

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

describe("Photos library", () => {
  it("upload → listed (metadata only, newest first) → view inline → download → delete (record and bytes gone)", async () => {
    expect((await add("anni", png(1), "beach.png")).status).toBe(201);
    expect((await add("anni", JPEG, "team.jpg")).status).toBe(201);
    const mine = await list("anni");
    expect(mine.map((p) => p.fileName).sort()).toEqual(["beach.png", "team.jpg"]);
    expect(mine.find((p) => p.fileName === "beach.png")).toMatchObject({ mimeType: "image/png", sizeBytes: png(1).length });
    expect(JSON.stringify(mine)).not.toMatch(/file_/); // no internal file ids
    expect(kinds()).toEqual([["anni", "library_photo"], ["anni", "library_photo"]]);

    const beach = mine.find((p) => p.fileName === "beach.png")!;
    const view = await open("anni", beach.recordId);
    expect(view.status).toBe(200);
    expect(view.headers.get("content-type")).toBe("image/png");
    expect(view.headers.get("content-disposition")).toMatch(/^inline; filename="beach.png"/);
    expect(view.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await view.arrayBuffer())).toEqual(png(1));
    expect((await open("anni", beach.recordId, "?download=1")).headers.get("content-disposition")).toMatch(/^attachment; filename="beach.png"/);

    const chunksBefore = sheets.dataRows("ChatFiles").length;
    expect((await del("anni", beach.recordId)).status).toBe(200);
    expect((await list("anni")).map((p) => p.fileName)).toEqual(["team.jpg"]);
    expect(sheets.dataRows("ChatFiles").length).toBeLessThan(chunksBefore);
    expect((await open("anni", beach.recordId)).status).toBe(404);
  });

  it("adding to Photos does NOT change the profile photo / avatar", async () => {
    expect(await avatarBytes("anni")).toBe(404); // no avatar uploaded
    await add("anni", png(5), "not-my-avatar.png");
    expect(await photoVersions()).toEqual({});
    expect(await avatarBytes("anni")).toBe(404);

    await setAvatar("anni", png(9), "avatar.png");
    const v1 = (await photoVersions()).anni;
    await add("anni", JPEG, "another.jpg");
    expect((await photoVersions()).anni).toBe(v1);
    expect(await avatarBytes("anni")).toEqual(png(9));
  });

  it("changing or setting the profile photo does NOT change Photos, and deleting a photo does not touch the avatar", async () => {
    await add("lukky", png(2), "keep.png");
    const before = await list("lukky");
    await setAvatar("lukky", png(3), "a1.png");
    await setAvatar("lukky", JPEG, "a2.jpg");
    expect(await list("lukky")).toEqual(before);
    await del("lukky", before[0].recordId);
    expect(await avatarBytes("lukky")).toEqual(JPEG);
    expect(kinds()).toEqual([["lukky", "photo"]]);
  });

  it("resumes and Photos stay separate", async () => {
    const cookie = await unlockedCookie("rishii");
    as("rishii");
    await resumeUploadRoute(await multipart("http://localhost/api/profile/resumes", PDF, "cv.pdf", cookie));
    await add("rishii", png(4), "pic.png");
    expect((await list("rishii")).map((p) => p.fileName)).toEqual(["pic.png"]);
    as("rishii");
    const resumes = (await (await resumesRoute(new Request("http://localhost/api/profile/resumes", { headers: { cookie } }))).json()).data as Info[];
    expect(resumes.map((r) => r.fileName)).toEqual(["cv.pdf"]);
  });
});

describe("security and validation", () => {
  it("a LOCKED Profile cannot list, view, download, upload or delete Photos — and learns nothing", async () => {
    await add("anni", png(1), "secret-photo.png");
    const [p] = await list("anni");
    const before = JSON.stringify([...sheets.tabs.entries()]);
    as("anni");
    const locked = [
      await listRoute(new Request("http://localhost/api/profile/photos")),
      await uploadRoute(await multipart("http://localhost/api/profile/photos", png(2), "x.png")),
      await openRoute(new Request(`http://localhost/api/profile/photos/${p.recordId}`), { params: Promise.resolve({ recordId: p.recordId }) }),
      await openRoute(new Request(`http://localhost/api/profile/photos/${p.recordId}?download=1`, { headers: { cookie: "jobsync_profile_unlock=garbage" } }), { params: Promise.resolve({ recordId: p.recordId }) }),
      await deleteRoute(new Request(`http://localhost/api/profile/photos/${p.recordId}`, { method: "DELETE", headers: { host: "localhost", origin: "http://localhost" } }), { params: Promise.resolve({ recordId: p.recordId }) }),
    ];
    for (const res of locked) {
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(JSON.parse(text).error).toMatchObject({ code: "profile_locked", message: "Unlock your Profile first." });
      expect(text).not.toContain("secret-photo");
      expect(text).not.toContain("image/png");
    }
    expect(JSON.stringify([...sheets.tabs.entries()])).toBe(before);
  });

  it("the unlock response includes MY photos only (and only after unlocking)", async () => {
    await add("anni", png(1), "anni-pic.png");
    await add("lukky", png(2), "lukky-pic.png");
    as("anni");
    const res = await unlockRoute(new Request("http://localhost/api/profile/unlock", { method: "POST", headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ password: TEST_PROFILE_PASSWORD }) }));
    const text = await res.text();
    expect(JSON.parse(text).data.photos.map((p: Info) => p.fileName)).toEqual(["anni-pic.png"]);
    expect(text).not.toContain("lukky-pic");
  });

  it("another member cannot see, view, download or delete my photos (answers like a missing file)", async () => {
    await add("anni", png(1), "private.png");
    const [p] = await list("anni");
    expect(await list("lukky")).toEqual([]);
    const peek = await open("lukky", p.recordId);
    expect(peek.status).toBe(404);
    expect(await peek.text()).not.toContain("PNG");
    expect((await open("rishii", p.recordId, "?download=1")).status).toBe(404);
    expect((await del("rishii", p.recordId)).status).toBe(404);
    expect(await list("anni")).toHaveLength(1);
    // Anni's own unlock cookie does not work in another member's session.
    expect((await open("lukky", p.recordId, "", await unlockedCookie("anni"))).status).toBe(403);
  });

  it("only JPEG, PNG or WebP (checked by content), at most 2 MB, at most 10 photos", async () => {
    for (const [bytes, name] of [[PDF, "doc.pdf"], [EXE, "fake.png"]] as const) {
      const res = await add("anni", bytes, name);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("file_type_not_allowed");
    }
    const big = new Uint8Array(2 * 1024 * 1024 + 10);
    big.set(png(1));
    expect((await add("anni", big, "big.png")).status).toBe(413);
    for (let i = 0; i < 10; i++) expect((await add("anni", png(i), `p${i}.png`)).status).toBe(201);
    resetUploadThrottleForTesting();
    const eleventh = await add("anni", png(11), "p11.png");
    expect(eleventh.status).toBe(409);
    expect((await eleventh.json()).error.message).toMatch(/at most 10 photos/);
    expect(await list("anni")).toHaveLength(10);
    expect(await list("lukky")).toHaveLength(0);
  });

  it("a failed upload leaves no record behind; retrying works; uploading the same file twice keeps two entries (like resumes)", async () => {
    sheets.failNext = { op: "append", error: Object.assign(new Error("boom"), { code: 503, response: { status: 503 } }) };
    expect((await add("anni", png(1), "retry.png")).status).toBeGreaterThanOrEqual(500);
    expect(sheets.dataRows("MemberFiles")).toHaveLength(0);
    expect((await add("anni", png(1), "retry.png")).status).toBe(201);
    expect((await add("anni", png(1), "retry.png")).status).toBe(201);
    expect((await list("anni")).map((p) => p.fileName)).toEqual(["retry.png", "retry.png"]);
  });

  it("existing MemberFiles records keep working (resumes and avatar rows untouched by the new kind)", async () => {
    sheets.rows("MemberFiles").push(["res_old1", "anni", "resume", "file_old1", "old.pdf", "application/pdf", "10", "2026-10-20T10:00:00.000Z"], ["pho_old1", "anni", "photo", "file_old2", "me.png", "image/png", "10", "2026-10-20T10:00:00.000Z"]);
    invalidateTableCache();
    expect(await list("anni")).toEqual([]);
    expect((await photoVersions()).anni).toBe("file_old2");
    const cookie = await unlockedCookie("anni");
    as("anni");
    const resumes = (await (await resumesRoute(new Request("http://localhost/api/profile/resumes", { headers: { cookie } }))).json()).data as Info[];
    expect(resumes.map((r) => r.fileName)).toEqual(["old.pdf"]);
  });
});
