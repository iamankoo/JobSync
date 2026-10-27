/**
 * Network Finder → the REAL Gmail module (OAuth tokens per member, NF_Drafts ledger) → a MOCK Google.
 * Three members connect through the real OAuth routes; one company run must leave exactly one draft in each
 * member's own mailbox and call no send endpoint. Also: the protected cron endpoint. Nothing real is contacted.
 */
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { GET as connect } from "@/app/api/gmail/connect/route";
import { GET as callback } from "@/app/api/gmail/callback/route";
import { GET as cron } from "@/app/api/cron/network-finder/route";
import type { MemberId } from "@/config/members";
import { GMAIL_COMPOSE_SCOPE } from "@/lib/gmail/config";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { loadNetworkFinderConfig } from "@/lib/network-finder/config";
import { InMemorySelectionStore } from "@/lib/network-finder/distribution";
import { existingConnections, existingDraftDeps, existingJobs } from "@/lib/network-finder/gateways";
import { processCompany, type CompanyTask } from "@/lib/network-finder/pipeline";
import { createWebsiteContactFinder } from "@/lib/network-finder/providers/website-contacts";
import { qualifyCompany } from "@/lib/network-finder/qualify";
import { InMemoryQueue } from "@/lib/network-finder/queue";
import { InMemoryCompanyRegistry } from "@/lib/network-finder/registry";
import { InMemoryBatchLedger } from "@/lib/network-finder/scheduler";
import { FakeSheets } from "../helpers/fake-sheets";
import { companySite, mockCompany, MockExtractor, mockWeb, testFetcher } from "../helpers/network-finder-mocks";

let sheets: FakeSheets;
const google = { drafts: [] as { token: string; raw: string }[], calls: [] as string[] };
const idToken = (email: string) => `h.${Buffer.from(JSON.stringify({ email, email_verified: true })).toString("base64url")}.s`;

beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
  google.drafts = [];
  google.calls = [];
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-client.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "test-client-secret");
  vi.stubEnv("GOOGLE_OAUTH_REDIRECT_URI", "http://localhost:3000/api/gmail/callback");
  vi.stubEnv("GMAIL_TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    google.calls.push(url.split("?")[0]);
    if (url === "https://oauth2.googleapis.com/token") {
      const p = new URLSearchParams(String(init?.body));
      if (p.get("grant_type") === "authorization_code") {
        const who = p.get("code")!.replace("code-for-", "");
        return Response.json({ access_token: `access-${who}`, refresh_token: `refresh-${who}`, scope: `openid email ${GMAIL_COMPOSE_SCOPE}`, id_token: idToken(`${who}@gmail.com`) });
      }
      return Response.json({ access_token: p.get("refresh_token")!.replace("refresh-", "access-") });
    }
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/drafts") {
      google.drafts.push({ token: (init?.headers as Record<string, string>).Authorization.replace("Bearer ", ""), raw: JSON.parse(String(init?.body)).message.raw });
      return Response.json({ id: `draft-${google.drafts.length}`, message: { threadId: `thread-${google.drafts.length}` } });
    }
    throw new Error(`unexpected request ${url}`);
  }));
});
afterEach(() => {
  setSheetsClientForTesting(null);
  vi.mocked(getSession).mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function connectGmail(m: MemberId) {
  vi.mocked(getSession).mockResolvedValue({ memberId: m, expiresAt: 9_999_999_999 });
  const start = await connect(new NextRequest("http://localhost:3000/api/gmail/connect"));
  const nonce = start.cookies.get("jobsync_gmail_oauth")!.value;
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  await callback(new NextRequest(`http://localhost:3000/api/gmail/callback?code=code-for-${m}&state=${encodeURIComponent(state)}`, { headers: { cookie: `jobsync_gmail_oauth=${nonce}` } }));
}

const decode = (raw: string) => {
  const msg = Buffer.from(raw, "base64url").toString("utf8");
  const [head, body] = msg.split("\r\n\r\n");
  return { head, body: Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8") };
};

describe("drafts land in each member's REAL Gmail module path (mock Google)", () => {
  it("every contact of a company → one draft in each of the three mailboxes, each with that member's own token; no send call", async () => {
    for (const m of ["anni", "lukky", "rishii"] as const) await connectGmail(m);
    const web = mockWeb(companySite("mock1.example.test", [
      { name: "Riya Talent", title: "Technical Recruiter", email: "riya.talent@mock1.example.test" },
      { name: "Sam Founder", title: "Co-Founder & CEO" },
    ]));
    const q = qualifyCompany(mockCompany(1));
    if (!q.qualified) throw new Error(q.reason);
    const out = await processCompany({
      config: { ...loadNetworkFinderConfig({ NETWORK_FINDER_ENABLED: "true", APP_TIMEZONE: "Asia/Kolkata" } as unknown as NodeJS.ProcessEnv), profiles: { lukky: "Final-year CS student who built a React Native expense app." }, signatures: { lukky: "Lukky K. | linkedin.example.test/lukky" } },
      sources: [],
      contactFinders: [createWebsiteContactFinder(testFetcher(web.fetchFn), new MockExtractor())],
      jobSources: [],
      queue: new InMemoryQueue<CompanyTask>(),
      registry: new InMemoryCompanyRegistry(),
      ledger: new InMemoryBatchLedger(),
      selections: new InMemorySelectionStore(),
      drafts: existingDraftDeps(),
      connections: existingConnections,
      jobs: existingJobs,
      now: () => new Date(Date.UTC(2026, 9, 27, 5, 0)),
    }, q.company);

    // Two contacts saved (the selected recruiter first, then the founder) × three mailboxes.
    expect(out.drafts?.map((d) => d.result)).toEqual(Array(6).fill("created"));
    expect(google.drafts.map((d) => d.token)).toEqual(["access-anni", "access-lukky", "access-rishii", "access-anni", "access-lukky", "access-rishii"]);
    for (const d of google.drafts.slice(0, 3)) expect(decode(d.raw).head).toContain("To: riya.talent@mock1.example.test");
    // The founder's address is predicted from the published pattern (labelled in Connections Notes).
    for (const d of google.drafts.slice(3)) expect(decode(d.raw).head).toContain("To: sam.founder@mock1.example.test");
    // Each draft carries ITS member's identity and links (and optional extra signature) — never another member's.
    const lukkyBody = decode(google.drafts[1].raw).body;
    expect(lukkyBody).toMatch(/Best regards,\r?\nLakshya Singh\r?\nLinkedIn: https:\/\/www\.linkedin\.com\/in\/lakshya-singh-243510302\/\r?\nGitHub: https:\/\/github\.com\/lukkydiwan/);
    expect(lukkyBody).toMatch(/-- \r?\nLukky K\. \| linkedin\.example\.test\/lukky$/);
    // The old free-text profile setting is not copied into emails (only verified structured facts are used).
    expect(lukkyBody).not.toContain("React Native expense app");
    const anniBody = decode(google.drafts[0].raw).body;
    expect(anniBody).toContain("Aniket Raj");
    expect(anniBody).not.toContain("Lukky K.");
    expect(anniBody).not.toContain("lukkydiwan");
    // Ledger: one row per (contact, member), status created, with Gmail's draft + thread IDs (no tokens).
    const ledger = sheets.dataRows("NF_Drafts");
    const saved = (await existingConnections.list()).map((c) => c.connectionId);
    expect(ledger).toHaveLength(6);
    expect(ledger.slice(0, 3).map((r) => [r[1], r[2], r[3], r[5]])).toEqual((["anni", "lukky", "rishii"] as const).map((m) => [m, "contact", out.selected!.connectionId, "created"]));
    expect(new Set(ledger.map((r) => r[3]))).toEqual(new Set(saved));
    expect(JSON.stringify(ledger)).not.toMatch(/refresh-|access-/);
    // Only token refresh + drafts.create were called: nothing that sends, deletes or modifies mail.
    expect(new Set(google.calls)).toEqual(new Set(["https://oauth2.googleapis.com/token", "https://gmail.googleapis.com/gmail/v1/users/me/drafts"]));
    expect(google.calls.some((u) => /send|trash|delete|modify/.test(u))).toBe(false);
  });
});

describe("the cron endpoint (cron-job.org)", () => {
  const call = (auth?: string) => cron(new Request("http://localhost:3000/api/cron/network-finder", auth ? { headers: { authorization: auth } } : {}));

  it("is closed without its secret, rejects a wrong one, and is off unless NETWORK_FINDER_ENABLED=true", async () => {
    expect((await call("Bearer x")).status).toBe(503); // no secret configured → disabled
    vi.stubEnv("NETWORK_FINDER_CRON_SECRET", "test-cron-secret");
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    const off = await call("Bearer test-cron-secret");
    expect(off.status).toBe(503);
    expect(JSON.stringify(await off.json())).toContain("NETWORK_FINDER_ENABLED");
    // Nothing was read or written while disabled.
    expect(sheets.calls.filter((c) => c.op !== "get" || !c.range.startsWith("Members"))).toEqual([]);
  });
});
