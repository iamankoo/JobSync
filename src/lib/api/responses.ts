import "server-only";
import { ZodError } from "zod";
import { DomainError, SheetsError, type DomainErrorCode, type SheetsErrorCode } from "@/lib/google-sheets/errors";

/** Error with an explicit HTTP status, thrown by route helpers. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const NO_STORE = { "Cache-Control": "no-store" };

/** Success envelope: `{ data }`. */
export function ok<T>(data: T, status = 200, meta?: Record<string, unknown>): Response {
  return Response.json(meta ? { data, meta } : { data }, { status, headers: NO_STORE });
}

/** Error envelope: `{ error: { code, message, details? } }`. */
export function errorJson(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  return Response.json({ error: { code, message, ...(details ? { details } : {}) } }, { status, headers: { ...NO_STORE, ...headers } });
}

const DOMAIN_STATUS: Record<DomainErrorCode, number> = {
  validation_failed: 400,
  duplicate_url: 409,
  job_not_found: 404,
  member_inactive: 403,
  invalid_transition: 409,
  not_job_owner: 403,
  follow_up_not_found: 404,
  follow_up_not_due: 409,
  follow_up_not_applicable: 409,
  follow_up_conflict: 409,
  follow_ups_unavailable: 503,
  retention_disabled: 403,
  retention_limit: 409,
  subscription_conflict: 409,
  connection_not_found: 404,
  not_connection_owner: 403,
  chat_file_not_found: 404,
  call_in_progress: 409,
  call_not_active: 409,
};

const SHEETS_STATUS: Record<SheetsErrorCode, number> = {
  not_configured: 503,
  auth_failed: 502,
  permission_denied: 502,
  spreadsheet_not_found: 502,
  rate_limited: 503,
  timeout: 504,
  upstream_error: 502,
  schema_invalid: 503,
  malformed_response: 502,
};

/** Converts any thrown value to a safe response. Internals and secrets are logged at most by name/code. */
export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) return errorJson(err.status, err.code, err.message, err.details);

  if (err instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const issue of err.issues) fields[issue.path.join(".") || "_"] ??= issue.message;
    return errorJson(400, "validation_failed", "Some fields are invalid.", { fields });
  }

  if (err instanceof DomainError) {
    return errorJson(DOMAIN_STATUS[err.code], err.code, err.message, err.details);
  }

  if (err instanceof SheetsError) {
    console.error(`[sheets] ${err.code}`);
    return errorJson(
      SHEETS_STATUS[err.code],
      "data_service_unavailable",
      err.publicMessage,
      undefined,
      err.code === "rate_limited" ? { "Retry-After": "5" } : undefined,
    );
  }

  console.error("[api] unexpected error", err instanceof Error ? err.name : typeof err);
  return errorJson(500, "internal_error", "Something went wrong. Please try again.");
}

export const MAX_BODY_BYTES = 16 * 1024;

/** Reads a size-limited JSON body. */
export async function readJsonBody(req: Request, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new ApiError(413, "payload_too_large", "Request body is too large.");
  const text = await req.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new ApiError(413, "payload_too_large", "Request body is too large.");
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON.");
  }
}
