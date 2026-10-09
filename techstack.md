# JobSync — Tech Stack

Versions below were read from the installed packages after Phase 1 (`package.json` uses caret ranges; `package-lock.json` pins exact versions). Local tooling: Node v24.14.0, npm 11.9.0.

## Installed (Phase 1)
| Technology | Version | Responsibility | Location |
|---|---|---|---|
| Next.js (App Router, Turbopack) | 16.4.0 | Routing, server components, route handlers | `src/app/` |
| React / React DOM | 19.3.0 | UI | `src/components/` |
| TypeScript | 6.0.3 | Type safety (`strict`) | everywhere; `src/types/` |
| Tailwind CSS (+ `@tailwindcss/postcss`) | 4.3.3 | Styling and design tokens | `src/app/globals.css` (`@theme` tokens) |
| Zod | 4.6.5 | Request validation | `src/lib/validation/` |
| jose | 6.2.12 | Signed (HS256) session tokens in HTTP-only cookies | `src/lib/auth/session.ts` |
| server-only | 0.0.1 | Build-time guard keeping secret-handling modules out of client bundles | `src/lib/auth/*` |
| lucide-react | 1.54.0 | Icons | components |
| ESLint (`eslint-config-next`) | 9.39.5 | Lint | `eslint.config.mjs` |
| Vitest + Testing Library | 5.0.3 | Unit and integration tests | `tests/unit`, `tests/integration` |
| Playwright + `@axe-core/playwright` | 1.64.0 / ^4.13.0 | End-to-end, responsive and accessibility tests | `tests/e2e` |

Accessible reusable UI components are built in-house in `src/components/ui/` with semantic HTML and ARIA; no headless component library was added.

## Planned (not installed yet)
| Technology | Why | Phase |
|---|---|---|
| `googleapis` (or `@googleapis/sheets`) | Official Sheets client | 2 |
| Recharts | No charting dependency exists; needed for donut/trend/contribution charts. Re-evaluate against `analytics.png` in Phase 4 (custom SVG is the fallback for the donut) | 4 |

## Locked by the owner
Next.js App Router, React, TypeScript, Tailwind CSS, Next.js route handlers, Google Sheets API as the only persistent store, Vercel hosting, server-only environment variables, Git/GitHub (`iamankoo/JobSync`).

## Prohibited for the initial version
Supabase, PostgreSQL, Prisma, MySQL, MongoDB, Firebase/Firestore, SQLite, Redis as a store, and any other persistent database.

## Development commands (all run in Phase 1)
| Command | Purpose |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` / `npm start` | Production build / serve |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest unit + integration tests |
| `npm run test:e2e` | Playwright e2e (starts its own dev server on port 3100; run `npx playwright install chromium` once first) |
