/**
 * Profile page API (own profile only, Members columns E–J), the Gmail page overview with all three members
 * connected, member-scoped disconnect, the Dashboard Connections counts and the Analytics "Emails Sent" metric.
 * In-memory sheet only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/session")>()), getSession: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { GET as getProfile, PUT as putProfile } from "@/app/api/profile/route";
import { POST as disconnect } from "@/app/api/gmail/disconnect/route";
import type { MemberId } from "@/config/members";
import { MEMBER_IDS } from "@/config/members";
import { gmailOverview } from "@/lib/gmail/overview";
import { emailsSentStats } from "@/lib/gmail/sent-stats";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { connectionStats } from "@/lib/google-sheets/connections-service";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { invalidateTableCache } from "@/lib/google-sheets/table";
import { FakeSheets } from "../helpers/fake-sheets";
import { unlockedCookie } from "../helpers/profile-unlock";

let sheets: FakeSheets;
let current: MemberId | null = null;
const as = (m: MemberId | null) => {
  current = m;
  vi.mocked(getSession).mockResolvedValue(m ? { memberId: m, expiresAt: 9_999_999_999 } : null);
};
// Profile routes need an unlocked Profile (see profile-lock.test.ts); these tests unlock as the current member.
const cookie = async (): Promise<Record<string, string>> => (current ? { cookie: await unlockedCookie(current) } : {});
const same = { host: "localhost", origin: "http://localhost", "content-type": "application/json" };
const put = async (body: unknown, headers: Record<string, string> = same) => putProfile(new Request("http://localhost/api/profile", { method: "PUT", headers: { ...headers, ...(await cookie()) }, body: JSON.stringify(body) }));
const get = async () => getProfile(new Request("http://localhost/api/profile", { headers: await cookie() }));
const full = { name: "Anni Kumari", linkedin: "https://www.linkedin.com/in/anni-k", github: "anni-k", email: "anni@example.com", mobile: "+91 98765 43210" };

beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
  invalidateTableCache();
});
afterEach(() => {
  setSheetsClientForTesting(null);
  vi.mocked(getSession).mockReset();
});

describe("Profile API", () => {
  it("starts empty (no invented values) and saves the member's own details", async () => {
    as("anni");
    const first = await (await get()).json();
    expect(first.data).toEqual({ name: "", linkedin: "", github: "", email: "", mobile: "", updatedAt: "" });

    const res = await put(full);
    expect(res.status).toBe(200);
    const saved = (await res.json()).data;
    expect(saved).toMatchObject(full);
    expect(saved.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Loads again when the member comes back.
    expect((await (await get()).json()).data).toMatchObject(full);
  });

  it("writes ONLY columns E–J of the member's own row (MemberID, Name, Photo, Active and other rows untouched)", async () => {
    const before = sheets.dataRows("Members").map((r) => [...r]);
    as("lukky");
    await put({ ...full, name: "Lukky L", email: "lukky@example.com" });
    const after = sheets.dataRows("Members");
    const lukky = after.find((r) => r[0] === "lukky")!;
    expect(lukky.slice(0, 4)).toEqual(before.find((r) => r[0] === "lukky")!.slice(0, 4));
    expect(lukky.slice(4, 9)).toStrictEqual(["Lukky L", full.linkedin, full.github, "lukky@example.com", full.mobile]);
    for (const id of ["anni", "rishii"]) expect(after.find((r) => r[0] === id)).toEqual(before.find((r) => r[0] === id));
    // (K3 is the Profile Password hash written when the test unlocks.)
    expect(sheets.calls.filter((c) => c.op === "update" && !/!K\d/.test(c.range)).map((c) => c.range)).toEqual(["Members!E3:J3"]);
  });

  it("can be edited later, including clearing a field", async () => {
    as("rishii");
    await put(full);
    const res = await put({ ...full, github: "", mobile: "0712 345678" });
    expect((await res.json()).data).toMatchObject({ github: "", mobile: "0712 345678" });
    expect((await (await get()).json()).data).toMatchObject({ github: "", mobile: "0712 345678", email: full.email });
  });

  it("each member only ever sees their own profile", async () => {
    as("anni");
    await put(full);
    as("lukky");
    const lukky = (await (await get()).json()).data;
    expect(lukky.email).toBe("");
    expect(JSON.stringify(lukky)).not.toContain("anni@example.com");
    // The body cannot name another member.
    expect((await put({ ...full, memberId: "anni" })).status).toBe(400);
    as("anni");
    expect((await (await get()).json()).data.email).toBe("anni@example.com");
  });

  it("validates input with field messages", async () => {
    as("anni");
    const res = await put({ ...full, email: "not-an-email", mobile: "call me", linkedin: "has space" });
    expect(res.status).toBe(400);
    const fields = (await res.json()).error.details.fields;
    expect(Object.keys(fields).sort()).toEqual(["email", "linkedin", "mobile"]);
  });

  it("requires a session and a same-origin request", async () => {
    as(null);
    expect((await get()).status).toBe(401);
    as("anni");
    expect((await put(full, { host: "localhost", origin: "https://evil.example", "content-type": "application/json" })).status).toBe(403);
  });

  it("works on a Members tab that has only the original four headers (like the current sheet)", async () => {
    sheets.rows("Members")[0] = ["MemberID", "Name", "Photo", "Active"];
    as("anni");
    expect((await put(full)).status).toBe(200);
    expect((await (await get()).json()).data).toMatchObject(full);
    expect(sheets.rows("Members")[0]).toEqual(["MemberID", "Name", "Photo", "Active"]);
  });
});

describe("Gmail page overview and disconnect", () => {
  const seedConnected = () => {
    for (const m of MEMBER_IDS) sheets.rows("NF_GmailAccounts").push([m, `${m}@gmail.com`, "enc-token", "openid email https://www.googleapis.com/auth/gmail.compose", "connected", "2026-10-27T10:00:00.000Z", "2026-10-27T10:00:00.000Z", ""]);
  };

  it("shows all three members as connected, and only MY address", async () => {
    seedConnected();
    for (const me of MEMBER_IDS) {
      const o = await gmailOverview(me, MEMBER_IDS);
      expect(o.members).toEqual(MEMBER_IDS.map((id) => ({ id, connected: true })));
      expect(o.me).toMatchObject({ status: "connected", email: `${me}@gmail.com` });
      const others = MEMBER_IDS.filter((m) => m !== me);
      for (const other of others) expect(JSON.stringify(o)).not.toContain(`${other}@gmail.com`);
    }
  });

  it("Disconnect only disconnects the signed-in member; the others stay connected", async () => {
    seedConnected();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));
    as("anni");
    const res = await disconnect(new Request("http://localhost/api/gmail/disconnect", { method: "POST", headers: { host: "localhost", origin: "http://localhost" } }));
    expect(res.status).toBe(200);
    vi.unstubAllGlobals();
    const rows = sheets.dataRows("NF_GmailAccounts");
    expect(rows.find((r) => r[0] === "anni")![4]).toBe("disconnected");
    expect(rows.find((r) => r[0] === "anni")![2]).toBe("");
    for (const m of ["lukky", "rishii"]) {
      expect(rows.find((r) => r[0] === m)![4]).toBe("connected");
      expect(rows.find((r) => r[0] === m)![2]).toBe("enc-token");
    }
    const o = await gmailOverview("lukky", MEMBER_IDS);
    expect(o.members).toEqual([{ id: "anni", connected: false }, { id: "lukky", connected: true }, { id: "rishii", connected: true }]);
  });
});

describe("Dashboard Connections card data", () => {
  it("counts the shared list by status", async () => {
    const row = (id: string, member: string, status: string) => [id, member, `Person ${id}`, "Acme", "", "", "", "", "", status, "2026-10-27T10:00:00.000Z", "2026-10-27T10:00:00.000Z", ""];
    sheets.rows("Connections").push(row("con_aaaaaaaaaa01", "anni", "Not Connected"), row("con_aaaaaaaaaa02", "lukky", "Messaged"), row("con_aaaaaaaaaa03", "anni", "Messaged"));
    expect(await connectionStats()).toEqual({ total: 3, byStatus: { "Not Connected": 1, Connected: 0, Messaged: 2, Reply: 0 } });
  });

  it("is null (card still links to Connections) when the optional tab does not exist", async () => {
    sheets.tabs.delete("Connections");
    expect(await connectionStats()).toBeNull();
  });
});

describe("Analytics Emails Sent metric", () => {
  const draft = (key: string, member: string, status: string) => [key, member, "contact", key, `d-${key}`, status, "2026-10-27T10:00:00.000Z", "", `t-${key}`, ""];

  it("counts only drafts Gmail shows as SENT — never created, deleted, skipped or failed", async () => {
    sheets.rows("NF_Drafts").push(
      draft("k1", "anni", "sent"), draft("k2", "anni", "sent"), draft("k3", "anni", "created"),
      draft("k4", "lukky", "sent"), draft("k5", "lukky", "deleted"), draft("k6", "rishii", "skipped_unauthorized"), draft("k7", "rishii", "failed"),
    );
    expect(await emailsSentStats()).toEqual({ total: 3, byMember: { anni: 2, lukky: 1, rishii: 0 } });
  });

  it("is zero with no sent drafts, and null when NF_Drafts does not exist", async () => {
    expect(await emailsSentStats()).toEqual({ total: 0, byMember: { anni: 0, lukky: 0, rishii: 0 } });
    sheets.tabs.delete("NF_Drafts");
    invalidateTableCache();
    expect(await emailsSentStats()).toBeNull();
  });
});
