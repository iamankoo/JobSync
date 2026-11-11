/**
 * Hands the outreach cycle over to the Netlify Background Function (`netlify/background-src/outreach-background.ts`, built to
 * `netlify/functions/outreach-background.mjs`). A background function answers its caller with 202 at once and keeps running for up to 15 minutes,
 * which the 30-60 s limit of an ordinary Next.js route cannot do.
 *
 * The function is protected by the same Bearer secret as the cron route, so the secret is forwarded; it is never logged or returned.
 */
export const BACKGROUND_FUNCTION_PATH = "/.netlify/functions/outreach-background";
export const DISPATCH_TIMEOUT_MS = 8_000;

export interface DispatchResult {
  ok: boolean;
  /** HTTP status of the hand-off, or 0 when the request itself failed (counts/codes only, never a body). */
  status: number;
}

export function backgroundUrl(req: Request, env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.OUTREACH_BACKGROUND_URL ?? "").trim();
  return override || new URL(BACKGROUND_FUNCTION_PATH, new URL(req.url).origin).toString();
}

export async function dispatchOutreachRunner(req: Request, env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Promise<DispatchResult> {
  const secret = env.OUTREACH_CRON_SECRET ?? "";
  try {
    const res = await fetchFn(backgroundUrl(req, env), {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}
