/**
 * Netlify BACKGROUND FUNCTION (15-minute limit): runs the JobSync outreach pipeline.
 *
 * Built by scripts/build-background.mjs into netlify/functions/outreach-background.mjs. The "-background" file name AND
 * netlify.toml ([functions."outreach-background"] background = true) make Netlify deploy it as a background function: the caller (the cron route)
 * gets 202 immediately and this handler keeps running. Whatever this handler returns is ignored by the platform, so it only logs.
 *
 * It must never throw: Netlify retries a failed background invocation, and the runner is already safe to restart on its own (runner lock +
 * per-cycle lock + write-ahead claims), so a clean return is always correct.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { buildRealRunnerDeps, runOutreachRunner } from "@/lib/outreach/runner";

const digest = (v: string) => createHash("sha256").update(v).digest();

export default async function handler(req: Request): Promise<Response> {
  try {
    const secret = process.env.OUTREACH_CRON_SECRET ?? "";
    const given = req.headers.get("authorization") ?? "";
    if (!secret || !timingSafeEqual(digest(given), digest(`Bearer ${secret}`))) {
      console.log(`[outreach-bg] ${JSON.stringify({ status: "unauthorised" })}`);
      return new Response(null, { status: 401 });
    }
    const deps = buildRealRunnerDeps();
    if (!deps) {
      console.log(`[outreach-bg] ${JSON.stringify({ status: "disabled" })}`);
      return new Response(null, { status: 202 });
    }
    await runOutreachRunner(deps);
  } catch (err) {
    console.log(`[outreach-bg] ${JSON.stringify({ status: "error", error: err instanceof Error ? err.name : "error" })}`);
  }
  return new Response(null, { status: 202 });
}
