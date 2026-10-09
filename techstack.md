# JobSync — Tech Stack

**Inspection result:** at preparation time the repository contains only `assets/`. There is no `package.json`, so nothing is installed yet and no installed versions or scripts can be documented. Everything below is therefore *planned*; exact versions and commands are recorded when Phase 1 creates the project. Local tooling observed: Node v24.14.0, npm 11.9.0, Git 2.53.0.

## Approved (locked by the owner)
| Technology | Responsibility | Location |
|---|---|---|
| Next.js (App Router) | Routing, server components, route handlers | `src/app/` |
| React | UI | `src/components/` |
| TypeScript | Type safety | everywhere; shared types in `src/types/` |
| Tailwind CSS | Styling, design tokens | global styles, `src/config/` tokens |
| Google Sheets API | Only persistent datastore | `src/lib/google-sheets/` (server-only) |
| Vercel | Hosting | deployment docs in `docs/deployment/` |
| Server-side auth + HTTP-only session cookies | Login, sessions, authorization | `src/lib/auth/` |
| Server-only env vars | Secrets and config | `.env.example`, Vercel settings |
| Git / GitHub | Version control (`iamankoo/JobSync`) | — |

## Proposed additions (all new; to be confirmed when added in the stated phase)
| Technology | Why | Phase |
|---|---|---|
| `googleapis` (or `@googleapis/sheets`) | Official Sheets client; the narrower package is preferred to limit size | 2 |
| Zod | Shared schemas for route input and spreadsheet rows, inferring TypeScript types | 1–2 |
| `server-only` | Build-time guard keeping secrets out of client bundles | 1 |
| A signed-cookie/JWT helper (`jose`) | Sign and verify session cookies without a database | 1 |
| Charting: Recharts | No dependencies exist to reuse; needed for donut, trend and contribution charts; React-native API, good fit. Re-evaluate against `analytics.png` in Phase 4 (custom SVG is the fallback for the donut) | 4 |
| Vitest + Testing Library | Unit and component/integration tests | 1 |
| Playwright | End-to-end tests and responsive checks; axe for accessibility | 1/5 |
| ESLint (Next config) + `tsc --noEmit` | Lint and type checks | 1 |

Accessible reusable UI components are built in-house in `src/components/ui/` using semantic HTML and ARIA; a headless library (e.g. Radix) may be added only if justified.

## Prohibited for the initial version
Supabase, PostgreSQL, Prisma, MySQL, MongoDB, Firebase/Firestore, SQLite, Redis as a store, and any other persistent database. Google Sheets is the sole datastore.

## Development commands
None verified yet — no project exists. They will be added here and in `README.md` after Phase 1 runs them.
