/**
 * JobSync puts NO numerical cap on how many e-mails are sent: not per member, not combined, not per rolling 24 hours, not per cron
 * execution. A shared Connection produces one e-mail per member and every eligible e-mail is sent until the queue is drained. The only
 * things that slow sending down are genuine ones: Gmail's own quotas and rate limits (see the member cool-down in send-workflow.ts),
 * the execution time budget of one cron call (the rest continues on the next call), and the safety checks themselves.
 *
 * The only numerical limit left in the outreach system is the IMPORT limit (200 new Connections from the Outreach Database per rolling
 * 24 hours, global), which lives in the importer and does not apply to sending or to manually added Connections.
 */

/** A claim that never reached "sending" is stale after this long (no API call was made, so it is safe to release). */
export const CLAIM_TTL_MS = 10 * 60_000;
