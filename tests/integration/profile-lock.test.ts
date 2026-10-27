/**
 * Profile Lock: first-time password (with confirmation), unlock, wrong password, admin (Anni) resets, Anni's
 * recovery question with rate limiting, and that no profile data ever leaves the server before an unlock.
 * In-memory sheet only.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/session")>()), getSession: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { POST as setPw } from "@/app/api/profile/password/route";
import { POST as unlock } from "@/app/api/profile/unlock/route";
import { POST as recover } from "@/app/api/profile/recover/route";
import { POST as adminReset } from "@/app/api/profile/admin/reset/route";
import { GET as getProfile, PUT as putProfile } from "@/app/api/profile/route";
import { GET as listResumes, POST as uploadResume } from "@/app/api/profile/resumes/route";
import { DELETE as deleteResume, GET as openResume } from "@/app/api/profile/resumes/[recordId]/route";
import { POST as uploadPhoto } from "@/app/api/profile/photo/route";
import { resetUploadThrottleForTesting } from "@/lib/chat/upload-throttle";
import type { MemberId } from "@/config/members";
import { hashSecret } from "@/lib/auth/password";
import { resetAllRateLimits } from "@/lib/auth/rate-limit";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { invalidateTableCache } from "@/lib/google-sheets/table";
import { FakeSheets } from "../helpers/fake-sheets";

let sheets: FakeSheets;
const as = (m: MemberId | null) => vi.mocked(getSession).mockResolvedValue(m ? { memberId: m, expiresAt: 9_999_999_999 } : null);
const HASH = 10; // column K (0-based index)
const RECOVERY = 11; // column L
const row = (m: MemberId) => sheets.dataRows("Members").find((r) => r[0] === m)!;
const post = (url: string, body: unknown, cookie?: string) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];

async function setPassword(m: MemberId, password: string, confirm = password) {
  as(m);
  return setPw(post("/api/profile/password", { password, confirm }));
}
async function unlockAs(m: MemberId, password: string) {
  as(m);
  return unlock(post("/api/profile/unlock", { password }));
}
async function recoverAs(m: MemberId, answer: string) {
  as(m);
  return recover(post("/api/profile/recover", { answer }));
}
async function resetAs(admin: MemberId, target: string, cookie?: string) {
  as(admin);
  return adminReset(post("/api/profile/admin/reset", { memberId: target }, cookie));
}
async function profileWith(m: MemberId, cookie?: string) {
  as(m);
  return getProfile(new Request("http://localhost/api/profile", { headers: cookie ? { cookie } : {} }));
}

beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
  invalidateTableCache();
  resetAllRateLimits();
  // Seed some profile data so we can prove it is not returned before unlocking.
  const r = row("lukky");
  r[4] = "Lukky Secret Name";
  r[7] = "lukky.private@example.com";
});
afterEach(() => {
  setSheetsClientForTesting(null);
  vi.mocked(getSession).mockReset();
});

describe("first-time Set Profile Password", () => {
  it("matching password + confirmation stores a salted hash (never plaintext) and unlocks with the profile", async () => {
    const res = await setPassword("lukky", "correct horse", "correct horse");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.profile).toMatchObject({ name: "Lukky Secret Name", email: "lukky.private@example.com" });
    expect(res.headers.get("set-cookie")).toMatch(/jobsync_profile_unlock=.+HttpOnly/i);
    const stored = row("lukky")[HASH];
    expect(stored).toMatch(/^scrypt1\$[^$]+\$[^$]+$/);
    expect(stored).not.toContain("correct horse");
    expect(JSON.stringify(sheets.tabs.get("Members"))).not.toContain("correct horse");
  });

  it("a mismatched confirmation NEVER creates or changes the stored password and does not unlock", async () => {
    const before = JSON.stringify(sheets.rows("Members"));
    const res = await setPassword("rishii", "first-try", "first-tyr");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe("Passwords do not match. Please try again.");
    expect(body.data).toBeUndefined();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(JSON.stringify(sheets.rows("Members"))).toBe(before);
    expect(sheets.calls.some((c) => c.op === "update")).toBe(false);

    // Also when a password already exists: a mismatch changes nothing.
    await setPassword("rishii", "real-pass", "real-pass");
    const hash = row("rishii")[HASH];
    expect((await setPassword("rishii", "other-pass", "other-pazz")).status).toBe(400);
    expect(row("rishii")[HASH]).toBe(hash);
    // Then entering the confirmation correctly works (here: a set password cannot be overwritten without a reset).
    expect((await setPassword("rishii", "other-pass", "other-pass")).status).toBe(409);
    expect(row("rishii")[HASH]).toBe(hash);
  });

  it("rejects too-short passwords without saving", async () => {
    expect((await setPassword("anni", "abc", "abc")).status).toBe(400);
    expect(row("anni")[HASH] ?? "").toBe("");
  });
});

describe("normal Profile access", () => {
  beforeEach(async () => {
    await setPassword("lukky", "lukky-pass-1");
  });

  it("correct password unlocks and returns the profile", async () => {
    const res = await unlockAs("lukky", "lukky-pass-1");
    expect(res.status).toBe(200);
    expect((await res.json()).data.profile.email).toBe("lukky.private@example.com");
    const cookie = cookieOf(res);
    expect((await profileWith("lukky", cookie)).status).toBe(200);
  });

  it("incorrect password stays locked: only \"Incorrect password.\", no profile data, no cookie", async () => {
    const res = await unlockAs("lukky", "wrong-pass");
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(JSON.parse(text).error.message).toBe("Incorrect password.");
    expect(text).not.toContain("lukky.private@example.com");
    expect(text).not.toContain("Lukky Secret Name");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("profile data and files are never returned without a valid unlock", async () => {
    for (const cookie of [undefined, "jobsync_profile_unlock=garbage"]) {
      const res = await profileWith("lukky", cookie);
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain("lukky.private@example.com");
    }
    as("lukky");
    expect((await listResumes(new Request("http://localhost/api/profile/resumes"))).status).toBe(403);
    expect((await putProfile(new Request("http://localhost/api/profile", { method: "PUT", headers: { host: "localhost", origin: "http://localhost" }, body: "{}" }))).status).toBe(403);
    // Another member's unlock cookie does not open Lukky's profile.
    await setPassword("rishii", "rishii-pass");
    const rishiiCookie = cookieOf(await unlockAs("rishii", "rishii-pass"));
    expect((await profileWith("lukky", rishiiCookie)).status).toBe(403);
  });

  it("wrong passwords are rate-limited", async () => {
    for (let i = 0; i < 5; i++) expect((await unlockAs("lukky", `nope-${i}`)).status).toBe(401);
    expect((await unlockAs("lukky", "lukky-pass-1")).status).toBe(429);
  });

  it("the Reset Password message is the UI's (no server recovery for non-admins)", async () => {
    // Lukky and Rishii have no recovery route.
    const res = await recoverAs("lukky", "anything");
    expect(res.status).toBe(403);
    expect((await res.json()).data).toBeUndefined();
    const ui = readFileSync(path.join(process.cwd(), "src/components/profile/profile-gate.tsx"), "utf8");
    expect(ui).toContain("Please contact the Admin to reset your password.");
  });
});

describe("admin Reset Passwords (Anni)", () => {
  let anniCookie: string;
  beforeEach(async () => {
    anniCookie = cookieOf(await setPassword("anni", "anni-admin-pass"));
    await setPassword("lukky", "lukky-old-pass");
    await setPassword("rishii", "rishii-old-pass");
  });

  it("Anni can reset Lukky and Rishii; nothing about the old password is returned", async () => {
    for (const target of ["lukky", "rishii"] as const) {
      const res = await resetAs("anni", target, anniCookie);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(JSON.parse(text).data).toEqual({ memberId: target });
      expect(text).not.toMatch(/scrypt1|old-pass/);
      expect(row(target)[HASH]).toBe("");
    }
  });

  it("reset invalidates the old password and the member's current unlock; they must set a new one", async () => {
    const lukkyCookie = cookieOf(await unlockAs("lukky", "lukky-old-pass"));
    expect((await profileWith("lukky", lukkyCookie)).status).toBe(200);
    await resetAs("anni", "lukky", anniCookie);
    expect((await profileWith("lukky", lukkyCookie)).status).toBe(403);
    const old = await unlockAs("lukky", "lukky-old-pass");
    expect(old.status).toBe(409);
    expect((await old.json()).error.code).toBe("password_not_set");
    // Next access: Set Profile Password works again.
    expect((await setPassword("lukky", "lukky-new-pass")).status).toBe(200);
    expect((await unlockAs("lukky", "lukky-old-pass")).status).toBe(401);
    expect((await unlockAs("lukky", "lukky-new-pass")).status).toBe(200);
  });

  it("Lukky and Rishii cannot call Reset Passwords, even with their own unlocked Profile", async () => {
    for (const m of ["lukky", "rishii"] as const) {
      const own = cookieOf(await unlockAs(m, `${m}-old-pass`));
      const res = await resetAs(m, "anni", own);
      expect(res.status).toBe(403);
    }
    expect(row("anni")[HASH]).toMatch(/^scrypt1\$/);
  });

  it("Anni must have his Profile unlocked to reset", async () => {
    expect((await resetAs("anni", "lukky")).status).toBe(403);
    expect(row("lukky")[HASH]).toMatch(/^scrypt1\$/);
  });
});

describe("Anni's \"Another way to unlock\"", () => {
  // A test-only answer: the real one is never in the repository (its hash lives in PROFILE_RECOVERY_ANSWER_HASH).
  const ANSWER = "Test Favourite Game";
  beforeEach(async () => {
    vi.stubEnv("PROFILE_RECOVERY_ANSWER_HASH", await hashSecret(ANSWER.toLowerCase()));
    await setPassword("anni", "forgotten-pass");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("the correct answer unlocks Anni's profile (case and surrounding spaces ignored)", async () => {
    const res = await recoverAs("anni", `  ${ANSWER.toLowerCase()} `);
    expect(res.status).toBe(200);
    expect((await res.json()).data.profile).toBeDefined();
    expect((await profileWith("anni", cookieOf(res))).status).toBe(200);
    expect((await recoverAs("anni", ANSWER.toUpperCase())).status).toBe(200);
  });

  it("a wrong answer does not unlock and returns no profile data", async () => {
    const res = await recoverAs("anni", "Tetris");
    expect(res.status).toBe(401);
    expect((await res.json()).data).toBeUndefined();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("recovery attempts are rate-limited (shared in the sheet): 5 wrong answers lock it, even for the right answer", async () => {
    for (let i = 0; i < 5; i++) expect((await recoverAs("anni", `guess-${i}`)).status).toBe(401);
    expect(row("anni")[RECOVERY]).toMatch(/^5\|\d+$/);
    resetAllRateLimits(); // a fresh server instance still sees the count
    const blocked = await recoverAs("anni", ANSWER);
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).data).toBeUndefined();
  });

  it("only Anni has it", async () => {
    await setPassword("rishii", "rishii-pass");
    expect((await recoverAs("rishii", ANSWER)).status).toBe(403);
    expect((await recoverAs("lukky", ANSWER)).status).toBe(403);
  });

  it("is unavailable (and unlocks nothing) when PROFILE_RECOVERY_ANSWER_HASH is not configured", async () => {
    vi.stubEnv("PROFILE_RECOVERY_ANSWER_HASH", "");
    const res = await recoverAs("anni", ANSWER);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("recovery_unavailable");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("no answer hash is embedded in the source; responses never echo the configured hash", async () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = path.join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|js|json)$/.test(f)) files.push(p);
      }
    };
    walk(path.join(process.cwd(), "src"));
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/scrypt1\$[A-Za-z0-9+/=]{10,}\$/);
    const configured = process.env.PROFILE_RECOVERY_ANSWER_HASH!;
    for (const answer of ["wrong", ANSWER]) expect(await (await recoverAs("anni", answer)).text()).not.toContain(configured);
  });
});
describe("nothing before unlock, and never another member's data", () => {
  const pdf = new TextEncoder().encode("%PDF-1.4\n% lock-test\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF");
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 1, 1, 1, 1]);
  async function multipart(url: string, bytes: Uint8Array, name: string, cookie?: string) {
    const fd = new FormData();
    fd.set("file", new File([bytes as BlobPart], name));
    const body = new Response(fd);
    const buf = await body.arrayBuffer();
    return new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": body.headers.get("content-type")!, "content-length": String(buf.byteLength), host: "localhost", origin: "http://localhost", ...(cookie ? { cookie } : {}) }, body: buf });
  }
  const withId = (id: string) => ({ params: Promise.resolve({ recordId: id }) });
  let anniCookie: string;
  let lukkyCookie: string;
  let anniResume: string;

  beforeEach(async () => {
    resetUploadThrottleForTesting();
    const a = row("anni");
    a[4] = "Anni Private Name";
    a[7] = "anni.private@example.com";
    sheets.rows("NF_GmailAccounts").push(
      ["anni", "anni.gmail@example.com", "enc-anni-token", "openid email https://www.googleapis.com/auth/gmail.compose", "connected", "2026-10-27T10:00:00.000Z", "2026-10-27T10:00:00.000Z", ""],
      ["lukky", "lukky.gmail@example.com", "enc-lukky-token", "openid email https://www.googleapis.com/auth/gmail.compose", "connected", "2026-10-27T10:00:00.000Z", "2026-10-27T10:00:00.000Z", ""],
    );
    anniCookie = cookieOf(await setPassword("anni", "anni-pass-1"));
    lukkyCookie = cookieOf(await setPassword("lukky", "lukky-pass-1"));
    as("anni");
    const up = await uploadResume(await multipart("/api/profile/resumes", pdf, "anni-cv.pdf", anniCookie));
    expect(up.status).toBe(201);
    anniResume = (await up.json()).data.recordId;
  });

  it("every Profile route refuses a locked request (no data, no change)", async () => {
    const before = JSON.stringify([...sheets.tabs.entries()]);
    as("anni");
    const locked = [
      await getProfile(new Request("http://localhost/api/profile")),
      await putProfile(new Request("http://localhost/api/profile", { method: "PUT", headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ name: "x", linkedin: "", github: "", email: "", mobile: "" }) })),
      await listResumes(new Request("http://localhost/api/profile/resumes")),
      await uploadResume(await multipart("/api/profile/resumes", pdf, "x.pdf")),
      await openResume(new Request(`http://localhost/api/profile/resumes/${anniResume}`), withId(anniResume)),
      await deleteResume(new Request(`http://localhost/api/profile/resumes/${anniResume}`, { method: "DELETE", headers: { host: "localhost", origin: "http://localhost" } }), withId(anniResume)),
      await uploadPhoto(await multipart("/api/profile/photo", png, "me.png")),
    ];
    for (const res of locked) {
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(JSON.parse(text).error.code).toBe("profile_locked");
      for (const secret of ["anni.private@example.com", "Anni Private Name", "anni-cv.pdf", "anni.gmail@example.com", "%PDF"]) expect(text).not.toContain(secret);
    }
    expect(JSON.stringify([...sheets.tabs.entries()])).toBe(before);
  });

  it("the unlock response carries only MY Gmail (address + status), never a token or another member's Gmail", async () => {
    const res = await unlockAs("anni", "anni-pass-1");
    const text = await res.text();
    expect(JSON.parse(text).data.gmail).toMatchObject({ status: "connected", email: "anni.gmail@example.com" });
    for (const s of ["enc-anni-token", "enc-lukky-token", "lukky.gmail@example.com", "scrypt1$"]) expect(text).not.toContain(s);
  });

  it("Lukky cannot read Anni's profile, resumes or resume file — not even with Anni's unlock cookie", async () => {
    as("lukky");
    const own = await (await getProfile(new Request("http://localhost/api/profile", { headers: { cookie: lukkyCookie } }))).text();
    expect(own).not.toContain("anni.private@example.com");
    expect(await (await listResumes(new Request("http://localhost/api/profile/resumes", { headers: { cookie: lukkyCookie } }))).json()).toEqual({ data: [] });
    expect((await openResume(new Request(`http://localhost/api/profile/resumes/${anniResume}`, { headers: { cookie: lukkyCookie } }), withId(anniResume))).status).toBe(404);
    expect((await deleteResume(new Request(`http://localhost/api/profile/resumes/${anniResume}`, { method: "DELETE", headers: { host: "localhost", origin: "http://localhost", cookie: lukkyCookie } }), withId(anniResume))).status).toBe(404);
    const stolen = await getProfile(new Request("http://localhost/api/profile", { headers: { cookie: anniCookie } }));
    expect(stolen.status).toBe(403);
    expect(await stolen.text()).not.toContain("anni.private@example.com");
  });

  it("Anni cannot read Lukky's profile either (the session decides whose data, never the request)", async () => {
    expect(row("lukky")[7]).toBe("lukky.private@example.com");
    as("anni");
    const mine = await (await getProfile(new Request("http://localhost/api/profile?memberId=lukky", { headers: { cookie: anniCookie } }))).json();
    expect(mine.data.email).toBe("anni.private@example.com");
    expect(JSON.stringify(mine)).not.toContain("lukky.private@example.com");
    expect((await getProfile(new Request("http://localhost/api/profile", { headers: { cookie: lukkyCookie } }))).status).toBe(403);
    expect((await unlockAs("anni", "lukky-pass-1")).status).toBe(401);
  });

  it("Anni can reset his OWN password: his unlock ends and he sets a new one next time", async () => {
    expect((await resetAs("anni", "anni", anniCookie)).status).toBe(200);
    expect((await profileWith("anni", anniCookie)).status).toBe(403);
    expect((await unlockAs("anni", "anni-pass-1")).status).toBe(409);
    expect((await setPassword("anni", "anni-pass-2")).status).toBe(200);
  });
});
