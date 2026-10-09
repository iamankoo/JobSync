# Testing

| Suite | Command | Covers |
|---|---|---|
| Unit | `npm test` | Access codes (leading zeros, per member, fail-closed in production), session sign/verify (tampered, expired, forged, unknown member), rate limiter, validation, nav items, member config |
| Integration | `npm test` | Login/logout route handlers: cookie flags, 400/401/403/429 handling, per-member rate limiting, no code echo |
| End-to-end | `npm run test:e2e` | Desktop and mobile (Pixel 7): profile selection, Back, show/hide code, wrong code, per-member name and accent theme, logout, forged cookies, route protection, five nav items, rate limit, no codes in client JS, axe accessibility, no horizontal scroll |
| Static | `npm run lint`, `npm run typecheck`, `npm run build` | Lint, types, production build |

One-time: `npx playwright install chromium`. E2E tests start their own dev server on port 3100.

## Visual check
The login screen was compared manually against `assets/login.png` (1536x1024). Profile photos differ from the reference because the real photos are used. Pixel-level automated comparison is part of Phase 5.
