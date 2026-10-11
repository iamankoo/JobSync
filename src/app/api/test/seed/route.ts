import { timingSafeEqual } from "node:crypto";
import { isMemoryBackend } from "@/lib/google-sheets/client";
import { memorySheets } from "@/lib/google-sheets/memory-client";
import { invalidateTableCache } from "@/lib/google-sheets/table";

/**
 * TEST-ONLY. Exists so the isolated browser E2E suite can reset/seed/inspect the in-memory
 * backend (for example to give an application an old AppliedAt and so simulate 168 hours without
 * waiting). It answers 404 unless SHEETS_TEST_BACKEND=memory outside production AND the caller
 * sends the matching TEST_SEED_KEY. It can never reach the real spreadsheet.
 */
const notFound = () => new Response(null, { status: 404 });

function authorised(req: Request): boolean {
  const key = process.env.TEST_SEED_KEY;
  const given = req.headers.get("x-test-key") ?? "";
  return Boolean(key) && given.length === key!.length && timingSafeEqual(Buffer.from(given), Buffer.from(key!));
}

export async function POST(req: Request) {
  if (!isMemoryBackend() || !authorised(req)) return notFound();
  const store = memorySheets();
  const body = (await req.json().catch(() => ({}))) as {
    action?: string; tab?: string; rows?: string[][]; where?: Record<string, string>; set?: Record<string, string>;
  };
  const tab = body.tab ?? "";

  switch (body.action) {
    case "reset":
      store.reset();
      break;
    case "append":
      store.rows(tab).push(...(body.rows ?? []).map((r) => [...r]));
      break;
    case "dump":
      return Response.json({ rows: store.rows(tab) });
    case "update": {
      // Update cells of every data row whose columns match `where`, addressing columns by header name.
      const rows = store.rows(tab);
      const header = rows[0];
      const col = (name: string) => header.indexOf(name);
      let changed = 0;
      for (const row of rows.slice(1)) {
        if (Object.entries(body.where ?? {}).every(([k, v]) => row[col(k)] === v)) {
          for (const [k, v] of Object.entries(body.set ?? {})) {
            while (row.length <= col(k)) row.push("");
            row[col(k)] = v;
          }
          changed += 1;
        }
      }
      invalidateTableCache();
      return Response.json({ changed });
    }
    default:
      return Response.json({ error: "unknown action" }, { status: 400 });
  }
  invalidateTableCache();
  return Response.json({ ok: true });
}
