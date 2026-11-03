/**
 * LIVE, READ-ONLY: prerequisites for the controlled outreach test (statuses and counts only: no tokens, endpoints or addresses printed).
 * Writes are forbidden by the wrapper. Run: npx vitest run --config vitest.live.config.mts tests/live/prod-prereqs.readonly.live.test.ts
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createGoogleClient, type SheetsClient } from "@/lib/google-sheets/client";
import { normalizePrivateKey } from "@/lib/google-sheets/config";
import { parseEnvFile } from "../helpers/live-env";

const root = path.resolve(__dirname, "..", "..");
const env = { ...parseEnvFile(path.join(root, ".env.local")), ...process.env } as Record<string, string | undefined>;
const ok = Boolean(env.GOOGLE_SHEETS_SPREADSHEET_ID && env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_PRIVATE_KEY);

function readOnly(id: string): SheetsClient {
  const real = createGoogleClient({ spreadsheetId: id, clientEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL!.trim(), privateKey: normalizePrivateKey(env.GOOGLE_PRIVATE_KEY!) });
  const refuse = () => { throw new Error("READ-ONLY"); };
  return { getValues: (r) => real.getValues(r), appendValues: refuse, updateValues: refuse, deleteRows: refuse } as SheetsClient;
}

describe.skipIf(!ok)("production prerequisites (read-only)", () => {
  it("reports Gmail connection status per member and push devices per member", async () => {
    const c = readOnly(env.GOOGLE_SHEETS_SPREADSHEET_ID!.trim());
    const gmail = (await c.getValues("NF_GmailAccounts!A:H")).slice(1).map((r) => ({ member: r[0], status: r[4], composeScope: /gmail\.compose/.test(r[3] ?? ""), metadataScope: /gmail\.metadata/.test(r[3] ?? ""), hasToken: Boolean(r[2]) }));
    const subs = (await c.getValues("PushSubscriptions!A:C")).slice(1).map((r) => r[1]);
    const devices: Record<string, number> = {};
    for (const m of subs) devices[m] = (devices[m] ?? 0) + 1;
    const members = (await c.getValues("Members!A:D")).slice(1).map((r) => ({ member: r[0], active: r[3] }));
    const conns = (await c.getValues("Connections!A:B")).slice(1).filter((r) => r[0]).length;
    fs.mkdirSync(path.join(root, "test-results"), { recursive: true });
    fs.writeFileSync(path.join(root, "test-results", "prod-prereqs.json"), JSON.stringify({ gmail, devices, members, connectionsNow: conns }, null, 1));
    expect(gmail.length).toBeGreaterThan(0);
  });
});
