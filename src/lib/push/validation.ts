import { z } from "zod";

/**
 * The server POSTs to a subscription's endpoint, so only genuine browser push services are accepted
 * (otherwise a signed-in member could make the server call arbitrary URLs).
 */
const PUSH_HOSTS: (string | RegExp)[] = [
  "fcm.googleapis.com", // Chrome, Edge (Chromium), Opera, Brave
  "updates.push.services.mozilla.com", // Firefox
  /^[a-z0-9.-]+\.push\.apple\.com$/, // Safari / iOS web apps
  /^[a-z0-9.-]+\.notify\.windows\.com$/, // legacy Edge
];

export function isAllowedPushEndpoint(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS.some((h) => (typeof h === "string" ? h === host : h.test(host)));
}

const base64url = z.string().min(8).max(256).regex(/^[A-Za-z0-9_-]+={0,2}$/, "Invalid key.");
const endpoint = z.string().max(2048).refine(isAllowedPushEndpoint, "Unsupported push service.");

/** Body of POST /api/push/subscriptions. Strict: no memberId, identity is the session. */
export const subscribeSchema = z.strictObject({
  endpoint,
  keys: z.strictObject({ p256dh: base64url, auth: base64url }),
});

/** Body of DELETE /api/push/subscriptions. */
export const unsubscribeSchema = z.strictObject({ endpoint });
