import { protectedRoute } from "@/lib/api/protected-route";
import { ok } from "@/lib/api/responses";
import { checkSheetsStatus } from "@/lib/google-sheets/status-service";

/** Read-only connectivity/schema check. Returns tab health only: no credentials, no cell contents. */
export const GET = protectedRoute(async () => ok(await checkSheetsStatus()));
