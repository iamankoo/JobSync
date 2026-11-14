/**
 * Sending limits. Each member sends from their OWN Gmail account and has their OWN allowance: at most MEMBER_DAILY_SEND_LIMIT confirmed JobSync
 * sends per rolling 24 hours, per member (never a combined limit). Only a confirmed send in the Send Ledger ("sent", with a Gmail message id)
 * counts; drafts a member sent by hand ("sent_outside") never do. Gmail's own quotas still apply on top (see the member cool-down in
 * send-workflow.ts), as do the execution time budget of one cycle and every safety check.
 *
 * The other numerical limit in the outreach system is the IMPORT limit (200 new Connections from the Outreach Database per rolling 24 hours,
 * global), which lives in the importer and does not apply to sending or to manually added Connections.
 */
export const MEMBER_DAILY_SEND_LIMIT = 200;
export const SEND_WINDOW_MS = 24 * 60 * 60_000;

/** A claim that never reached "sending" is stale after this long (no API call was made, so it is safe to release). */
export const CLAIM_TTL_MS = 10 * 60_000;
