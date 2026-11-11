/**
 * An EMPTY Drafts folder: Gmail answers drafts.list with HTTP 204 and no body (seen live for Lukky on 12 Nov 2026). That is a complete, empty listing. The
 * listing code used to read it as "unreadable", which made the 100-draft gate fail closed and kept the "not in Gmail Drafts" pre-filter from ever engaging.
 * Mock fetch only; `accessFor` is mocked. No network.
 */
import { describe, expect, it, vi } from "vitest";

const state = { access: "ok" as "ok" | "not_authorized" | "failed" };
vi.mock("@/lib/gmail/drafts", () => ({
  GMAIL_API: "https://gmail.googleapis.com/gmail/v1/users/me",
  DRAFTS_ENDPOINT: "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
  accessFor: vi.fn(async () => (state.access === "ok" ? { ok: true, token: "tok", scopes: [] } : { ok: false, status: state.access, reason: "x" })),
}));
vi.mock("@/lib/gmail/store", () => ({ readDraftLedger: vi.fn(async () => new Map()) }));

import { countPendingGmailDrafts, createDraftPresence, realBacklogPorts } from "@/lib/gmail/draft-backlog";

const res = (status: number, body?: unknown) => (status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body ?? {}), { status, headers: { "content-type": "application/json" } }));
const ports = (...answers: Response[]) => {
  const queue = [...answers];
  const f = vi.fn(async () => queue.shift() ?? res(500)) as unknown as typeof fetch;
  return { p: realBacklogPorts(f), f };
};

describe("drafts.list for an empty Drafts folder", () => {
  it("HTTP 204 with no body is an empty, complete listing", async () => {
    const { p } = ports(res(204));
    expect(await p.gmailDraftIds("lukky")).toEqual({ status: "ok", ids: new Set() });
  });
  it("HTTP 200 with an empty object is the same", async () => {
    const { p } = ports(res(200, {}));
    expect(await p.gmailDraftIds("lukky")).toEqual({ status: "ok", ids: new Set() });
  });
  it("real answers still work: ids, paging, and a 204 on a LATER page just ends the listing", async () => {
    const { p } = ports(res(200, { drafts: [{ id: "a" }, { id: "b" }], nextPageToken: "n" }), res(204));
    expect(await p.gmailDraftIds("anni")).toEqual({ status: "ok", ids: new Set(["a", "b"]) });
  });
  it("genuine failures are STILL unavailable (never read as empty): HTTP errors, a garbled 200, and a network failure", async () => {
    for (const answer of [res(500), res(429), res(403), new Response("not json", { status: 200 })]) {
      const { p } = ports(answer);
      expect((await p.gmailDraftIds("lukky")).status).toBe("unavailable");
    }
    const boom = realBacklogPorts((async () => { throw new Error("net"); }) as unknown as typeof fetch);
    expect((await boom.gmailDraftIds("lukky")).status).toBe("unavailable");
  });
});

describe("what that fixes", () => {
  it("the backlog count no longer goes 'unknown' (fail closed) because one member's folder is empty", async () => {
    const lists = { anni: new Set(["a1", "a2"]), lukky: new Set<string>(), rishii: new Set(["r1"]) };
    const count = await countPendingGmailDrafts({
      ledgerPending: async () => [
        { memberId: "anni", gmailDraftId: "a1", detail: "" }, { memberId: "anni", gmailDraftId: "a2", detail: "" },
        { memberId: "lukky", gmailDraftId: "l1", detail: "" }, { memberId: "lukky", gmailDraftId: "l2", detail: "" }, // stale: Lukky's folder is empty
        { memberId: "rishii", gmailDraftId: "r1", detail: "" },
      ],
      gmailDraftIds: async (m) => ({ status: "ok", ids: lists[m] }),
    });
    expect(count).toEqual({ status: "ok", pending: 3, byMember: { anni: 2, lukky: 0, rishii: 1 }, parked: 0 });
  });
  it("the presence pre-filter now says 'absent' for every ledger draft of a member whose folder is empty", async () => {
    const { p } = ports(res(204));
    const presence = createDraftPresence({ list: (m) => p.gmailDraftIds(m) });
    expect(await presence.has("lukky", "r7834412791001417722")).toBe("absent");
  });
});
