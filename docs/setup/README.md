# Setup

## Local development
1. `npm install`
2. Optionally copy `.env.example` to `.env.local` and set values.
3. `npm run dev`

## Environment variables (Phase 1)
| Variable | Purpose |
|---|---|
| `SESSION_SECRET` | Signs session cookies. Required (>= 32 chars) in production; a dev-only fallback is used otherwise. |
| `SESSION_MAX_AGE_SECONDS` | Session lifetime; default 28800 (8 hours). |
| `ACCESS_CODE_ANNI`, `ACCESS_CODE_LUKKY`, `ACCESS_CODE_RISHII` | Per-member access codes, compared as strings (leading zeros kept). |

## Prototype access codes
Outside production, if an `ACCESS_CODE_*` variable is unset, the server falls back to the prototype codes (Anni `0001`, Lukky `0002`, Rishii `0003`). They exist only in server code, are never sent to the browser, and are disabled in production. **They must be rotated or replaced with properly managed secrets before production**; set the three env vars to new values.

Google Sheets setup is documented in Phase 2.
