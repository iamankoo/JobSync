/**
 * Errors from external providers (YC, Wellfound, Apollo, job sources). A provider that cannot deliver
 * real data throws one of these; it never returns invented data.
 */
export type ProviderErrorKind =
  | "not_configured" // no credentials / adapter not connected yet
  | "unavailable" // the service is down or unreachable
  | "rate_limited" // the provider asked us to slow down (retryAt says until when, if known)
  | "quota_exhausted" // a plan/credit limit was reached (retryAt = when it resets, if known)
  | "auth_failed"
  | "forbidden" // access not permitted (robots, terms, blocked) — never worked around
  | "invalid_response";

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly kind: ProviderErrorKind,
    message: string,
    readonly retryAt?: number,
  ) {
    super(`${provider}: ${kind}: ${message}`);
    this.name = "ProviderError";
  }

  /** Worth trying again later (as opposed to a configuration or permission problem). */
  get transient(): boolean {
    return this.kind === "unavailable" || this.kind === "rate_limited" || this.kind === "quota_exhausted";
  }
}

/** Every Apollo account is paused or out of quota: the queue must pause until `resumeAt`. */
export class ApolloPoolExhausted extends Error {
  constructor(readonly resumeAt: number) {
    super(`all Apollo accounts are exhausted until ${new Date(resumeAt).toISOString()}`);
    this.name = "ApolloPoolExhausted";
  }
}
