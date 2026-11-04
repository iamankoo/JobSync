import { createHash, timingSafeEqual } from "node:crypto";
import { errorJson, errorResponse } from "@/lib/api/responses";
import { accessFor } from "@/lib/gmail/drafts";
import { createGoogleClient } from "@/lib/google-sheets/client";
import { loadSheetsConfig } from "@/lib/google-sheets/config";
import { deleteConnection } from "@/lib/google-sheets/connections-service";
import { loadOutreachConfig } from "@/lib/outreach/config";
import { realConnectionsPort } from "@/lib/outreach/run";
import { cleanupTestArtifacts } from "@/lib/outreach/test-cleanup";

export const maxDuration = 60;
const digest = (v: string) => createHash("sha256").update(v).digest();

/**
 * One-off removal of the controlled-test artefacts (see src/lib/outreach/test-cleanup.ts for the positive-identification rules).
 *
 *   POST /api/cron/outreach-cleanup      Authorization: Bearer $OUTREACH_CRON_SECRET
 *   body: { "confirm": "delete-test-artifacts", "dryRun": true | false }
 *
 * INERT unless OUTREACH_TEST_CLEANUP_BASE (the test mailbox, e.g. "me@gmail.com") is set; unset it afterwards. It only ever selects the
 * ten generated test contacts derived from that address. Runs on the server so Gmail drafts are deleted with each member's own
 * production authorisation. Idempotent. The response carries counts only.
 */
export async function POST(req: Request) {
  const secret = process.env.OUTREACH_CRON_SECRET;
  const base = (process.env.OUTREACH_TEST_CLEANUP_BASE ?? "").trim().toLowerCase();
  const [local, domain] = base.split("@");
  if (!secret || !local || !domain) return errorJson(503, "cleanup_disabled", "The test cleanup is not enabled.");
  const given = req.headers.get("authorization") ?? "";
  if (!timingSafeEqual(digest(given), digest(`Bearer ${secret}`))) return errorJson(401, "unauthenticated", "Invalid credentials.");
  let body: { confirm?: string; dryRun?: boolean } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* no body */
  }
  if (body.confirm !== "delete-test-artifacts") return errorJson(400, "confirmation_required", 'Send {"confirm":"delete-test-artifacts"}.');
  try {
    const cfg = loadOutreachConfig();
    const sheets = loadSheetsConfig();
    if (!cfg.spreadsheetId || cfg.spreadsheetId === sheets.spreadsheetId) return errorJson(503, "cleanup_disabled", "OUTREACH_SPREADSHEET_ID is not valid.");
    const report = await cleanupTestArtifacts({
      local,
      domain,
      outreach: createGoogleClient({ ...sheets, spreadsheetId: cfg.spreadsheetId }),
      prod: createGoogleClient(sheets),
      listConnections: realConnectionsPort.listFresh,
      deleteConnection: async (owner, id) => { await deleteConnection(owner, id); },
      deleteGmailDraft: async (member, draftId) => {
        const access = await accessFor(member, fetch);
        if (!access.ok) return "error";
        const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${access.token}` }, signal: AbortSignal.timeout(15_000) });
        return res.status === 204 || res.status === 200 ? "deleted" : res.status === 404 ? "gone" : "error";
      },
      dryRun: body.dryRun !== false, // a real deletion needs an explicit "dryRun": false
    });
    console.log(`[outreach-cleanup] ${JSON.stringify(report)}`);
    return Response.json({ data: report }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
