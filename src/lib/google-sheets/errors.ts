import "server-only";

export type SheetsErrorCode =
  | "not_configured" // env vars missing or malformed
  | "auth_failed" // credentials rejected by Google
  | "permission_denied" // spreadsheet not shared with the service account
  | "spreadsheet_not_found"
  | "rate_limited" // Google quota / 429
  | "timeout"
  | "upstream_error" // 5xx / network / unexpected response
  | "schema_invalid" // tab or header mismatch
  | "malformed_response";

/**
 * Error raised by the data layer. `message` is always safe to log; it never contains secrets.
 * `publicMessage` is safe to show to API clients.
 */
export class SheetsError extends Error {
  constructor(
    readonly code: SheetsErrorCode,
    readonly publicMessage: string,
    options?: { cause?: unknown },
  ) {
    super(`${code}: ${publicMessage}`, options);
    this.name = "SheetsError";
  }
}

/** Domain-level errors thrown by services; mapped to 4xx responses. */
export type DomainErrorCode =
  | "validation_failed"
  | "duplicate_url"
  | "job_not_found"
  | "member_inactive"
  | "invalid_transition"
  | "not_job_owner"
  | "follow_up_not_found"
  | "follow_up_not_due"
  | "follow_up_not_applicable"
  | "follow_up_conflict"
  | "follow_ups_unavailable"
  | "retention_disabled"
  | "retention_limit"
  | "subscription_conflict"
  | "connection_not_found"
  | "not_connection_owner"
  | "chat_file_not_found"
  | "call_in_progress"
  | "call_not_active"
  | "not_call_starter";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
