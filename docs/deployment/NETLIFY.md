# Deployment (Netlify)

Production: **https://jobsync-app.netlify.app** (Netlify site `jobsync-app`, GitHub repo `iamankoo/JobSync`, branch `main`, built by Netlify CI on Linux).
The Vercel notes in `README.md` are historical (the Vercel account was blocked on 10 Nov 2026).

## How the outreach pipeline runs on Netlify

```
cron-job.org (every 2 min)
  -> GET /api/cron/outreach            Next.js route: checks the Bearer secret and OUTREACH_ENABLED, then hands over
       -> POST /.netlify/functions/outreach-background    Netlify BACKGROUND function (15-minute limit), same Bearer secret
            -> runner (src/lib/outreach/runner.ts): takes the "bg-runner" lock, then runs the unchanged outreach cycle
               every 2 minutes for up to 12 minutes, renewing the lock every 40 s; the next cron call starts a fresh runner
```

Why: an ordinary Netlify function (and the Next.js route) is cut off after about 30 s, but one cycle needs up to 55 s. Netlify *scheduled*
functions are limited to 30 s as well, so cron-job.org stays the trigger. `after()` is not used for the long-running work.

- **Source:** `netlify/background-src/outreach-background.ts`. `scripts/build-background.mjs` bundles it with esbuild (resolving `@/` imports, stubbing
  `server-only` / `next/headers` / `next/server`) into `netlify/functions/outreach-background.mjs` (generated, git-ignored) before `next build`
  (`npm run build:netlify`, set as the build command in `netlify.toml`).
- **Background flag:** the `-background` file name plus `[functions."outreach-background"] background = true`. `netlify build` writes
  `.netlify/functions/manifest.json`; the entry must show `"invocationMode": "background"` (the Next.js handler shows `"stream"`).
- **Locks:** `run-lock` (65 s TTL) still serialises single cycles, exactly as before. `bg-runner` (120 s TTL, heartbeat every 40 s) keeps two background
  runners from running side by side; a killed runner stops renewing and the lock expires on its own. A cycle that passes its hard stop is waited for
  (30 s grace); if it never settles the runner stops WITHOUT releasing its lock.
- **Cadence:** `OUTREACH_CYCLE_INTERVAL_S` (60-600, default 120) sets the gap between cycle starts. Import limit (200 per rolling 24 h), the 100-draft gate,
  and the absence of a send cap are unchanged: they live in the cycle, which this change does not touch.
- **Logs:** `netlify logs --function outreach-background` / the Netlify UI show `[outreach-runner] {...}` (runner) and `[outreach] {...}` (each cycle).

## Environment variables (names; values are in the Netlify dashboard, never in Git)
Same as the Vercel setup (`.env.example`), plus: `LEGAL_CONTACT_EMAIL` (public contact on /privacy and /terms), optional `OUTREACH_CYCLE_INTERVAL_S`,
optional `OUTREACH_BACKGROUND_URL` (override of the background function address). On the Free plan variables cannot be marked secret or scoped.
