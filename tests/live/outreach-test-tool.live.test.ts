/**
 * LIVE tool for the CONTROLLED outreach test (production sheets, labelled test contacts only). Runs ONE action chosen by environment:
 *
 *   OUTREACH_TEST_ACTION=seed     creates the isolated "Test Contacts" tab in the Outreach Database with 10 labelled contacts
 *   OUTREACH_TEST_ACTION=status   read-only progress snapshot -> test-results/outreach-test-status.json (no personal data)
 *   OUTREACH_TEST_ACTION=cleanup  removes every test artefact (see tests/helpers/outreach-test-tool.ts); real rows are never selected
 *
 *   needs OUTREACH_SPREADSHEET_ID and OUTREACH_TEST_EMAIL_BASE (e.g. me@gmail.com -> me+jobsync01@gmail.com ...)
 *   npx vitest run --config vitest.live.config.mts tests/live/outreach-test-tool.live.test.ts
 *
 * Skipped unless OUTREACH_TEST_ACTION is set. It never sends mail and never touches Master Contacts.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { MemberId } from "@/config/members";
import { accessFor } from "@/lib/gmail/drafts";
import { createGoogleClient, setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { normalizePrivateKey } from "@/lib/google-sheets/config";
import { deleteConnection, listConnections } from "@/lib/google-sheets/connections-service";
import { OutreachSheet } from "@/lib/outreach/sheet";
import { MASTER_FIELDS } from "@/lib/hr-master/types";
import { MASTER_TAB, TRACKING_TAB } from "@/lib/outreach/types";
import { parseEnvFile } from "../helpers/live-env";
import { TEST_TAB, buildTestContactRows, cleanupTestArtifacts, testContactIds, testEmails } from "../helpers/outreach-test-tool";

const root = path.resolve(__dirname, "..", "..");
const envFile = parseEnvFile(path.join(root, ".env.local"));
for (const [k, v] of Object.entries(envFile)) if (process.env[k] === undefined) process.env[k] = v; // the app's own config readers use process.env
const env = process.env as Record<string, string | undefined>;
const action = env.OUTREACH_TEST_ACTION;
const outreachId = env.OUTREACH_SPREADSHEET_ID?.trim();
const prodId = env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim();
const base = (env.OUTREACH_TEST_EMAIL_BASE ?? "").trim().toLowerCase();
const [local, domain] = base.split("@");
const ready = Boolean(action && outreachId && prodId && outreachId !== prodId && local && domain);

const creds = () => ({ clientEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL!.trim(), privateKey: normalizePrivateKey(env.GOOGLE_PRIVATE_KEY!) });
const require = createRequire(import.meta.url);
function rawApi() {
  const { auth, sheets } = require(path.join(root, "node_modules/@googleapis/sheets"));
  const c = creds();
  return sheets({ version: "v4", auth: new auth.JWT({ email: c.clientEmail, key: c.privateKey, scopes: ["https://www.googleapis.com/auth/spreadsheets"] }) });
}

describe.skipIf(!ready)(`controlled outreach test tool (${action})`, () => {
  it.runIf(action === "seed")("creates the isolated Test Contacts tab with 10 labelled contacts (Master Contacts untouched)", async () => {
    const api = rawApi();
    const meta = await api.spreadsheets.get({ spreadsheetId: outreachId, fields: "properties.title,sheets.properties" });
    expect(meta.data.properties.title).toBe("Outreach Database");
    const has = (meta.data.sheets ?? []).some((s: { properties: { title: string } }) => s.properties.title === TEST_TAB);
    if (!has) await api.spreadsheets.batchUpdate({ spreadsheetId: outreachId, requestBody: { requests: [{ addSheet: { properties: { title: TEST_TAB, gridProperties: { rowCount: 50, columnCount: MASTER_FIELDS.length, frozenRowCount: 1 } } } }] } });
    const rows = buildTestContactRows(local, domain);
    await api.spreadsheets.values.update({ spreadsheetId: outreachId, range: `'${TEST_TAB}'!A1`, valueInputOption: "RAW", requestBody: { values: [[...MASTER_FIELDS], ...rows] } });
    const back = await createGoogleClient({ spreadsheetId: outreachId!, ...creds() }).getValues(`'${TEST_TAB}'!A:A`);
    expect(back.length - 1).toBe(10);
  });

  it.runIf(action === "status")("writes a read-only progress snapshot", async () => {
    const out = createGoogleClient({ spreadsheetId: outreachId!, ...creds() });
    const prod = createGoogleClient({ spreadsheetId: prodId!, ...creds() });
    const sheet = new OutreachSheet(out);
    const ids = testContactIds(local, domain);
    const emails = testEmails(local, domain);
    const tracking = (await sheet.readTracking()).records;
    const mine = tracking.filter((t) => ids.has(t.contactId));
    const ledger = (await sheet.readSendLedger()).records.filter((r) => emails.has(r.sendKey));
    const state = (await out.getValues("'Outreach State'!A:C")).slice(1).map((r) => ({ key: r[0], value: String(r[1] ?? "").replace(/^(done|[0-9a-f-]{36}).*/, (m) => (m.startsWith("done") ? "done" : "claimed")) }));
    const conns = (await prod.getValues("Connections!A:M")).slice(1).filter((r) => emails.has((r[12] ?? "").toLowerCase()));
    const drafts = (await prod.getValues("NF_Drafts!A:J")).slice(1).filter((r) => conns.some((c) => c[0] === r[3]));
    const count = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
    const counters = (await out.getValues("'Outreach Daily Counters'!A:S")).slice(1).map((r) => r.slice(0, 19));
    const snapshot = {
      at: new Date().toISOString(),
      testTabRows: Math.max(0, (await out.getValues(`'${TEST_TAB}'!A:A`).catch(() => [[]])).length - 1),
      masterContactsRows: (await out.getValues(`'${MASTER_TAB}'!A:A`)).length - 1,
      trackingTotal: tracking.length,
      trackingTest: { count: mine.length, importStatus: count(mine.map((t) => t.importStatus)), processing: count(mine.map((t) => t.processing)), sendStatus: count(mine.map((t) => t.sendStatus)), owners: count(mine.map((t) => t.ownerMemberId)), blockReasons: count(mine.filter((t) => t.sendBlockReason).map((t) => t.sendBlockReason.slice(0, 90))), resumes: count(mine.map((t) => t.resumeSent || "-")) },
      sendLedger: { count: ledger.length, status: count(ledger.map((r) => r.status)), withMessageId: ledger.filter((r) => r.gmailMessageId).length, resumeFiles: count(ledger.map((r) => r.resumeFile)) },
      testConnectionsInProduction: conns.length,
      draftLedgerForTestConnections: { count: drafts.length, status: count(drafts.map((d) => d[5])), byMember: count(drafts.map((d) => d[1])), reviewFlagged: drafts.filter((d) => /review:/.test(d[7] ?? "")).map((d) => (d[7] ?? "").slice(0, 120)) },
      outreachState: state,
      counterRows: counters,
    };
    fs.mkdirSync(path.join(root, "test-results"), { recursive: true });
    fs.writeFileSync(path.join(root, "test-results", "outreach-test-status.json"), JSON.stringify(snapshot, null, 1));
    expect(snapshot.masterContactsRows).toBe(15891);
  });

  it.runIf(action === "cleanup")("removes the test artefacts (Connections, drafts, tracking, ledger, milestone state, Test Contacts tab)", async () => {
    expect(env.OUTREACH_TEST_CONFIRM_CLEANUP).toBe("yes");
    const out = createGoogleClient({ spreadsheetId: outreachId!, ...creds() });
    const prod = createGoogleClient({ spreadsheetId: prodId!, ...creds() });
    setSheetsClientForTesting(prod); // the application services (Connections, Gmail accounts) read/write the production sheet through this
    const report = await cleanupTestArtifacts({
      local, domain, outreach: out, prod,
      listConnections,
      deleteConnection: async (owner, id) => { await deleteConnection(owner, id); },
      deleteGmailDraft: async (member: MemberId, draftId: string) => {
        const access = await accessFor(member, fetch);
        if (!access.ok) return "error";
        const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${access.token}` } });
        return res.status === 204 || res.status === 200 ? "deleted" : res.status === 404 ? "gone" : "error";
      },
    });
    fs.mkdirSync(path.join(root, "test-results"), { recursive: true });
    fs.writeFileSync(path.join(root, "test-results", "outreach-test-cleanup.json"), JSON.stringify(report, null, 1));
    expect(report.gmailDraftErrors).toBe(0);
    // finally remove the isolated test tab itself
    const api = rawApi();
    const meta = await api.spreadsheets.get({ spreadsheetId: outreachId, fields: "sheets.properties" });
    const tab = (meta.data.sheets ?? []).find((s: { properties: { title: string } }) => s.properties.title === TEST_TAB);
    if (tab) await api.spreadsheets.batchUpdate({ spreadsheetId: outreachId, requestBody: { requests: [{ deleteSheet: { sheetId: tab.properties.sheetId } }] } });
    expect((await out.getValues(`'${MASTER_TAB}'!A:A`)).length - 1).toBe(15891);
    setSheetsClientForTesting(null);
    expect(TRACKING_TAB).toBeTruthy();
  });
});
