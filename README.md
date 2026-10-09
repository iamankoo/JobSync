# JobSync

A private job-tracking web app shared by three members: **Anni** (blue), **Lukky** (yellow) and **Rishii** (red).
Screens: Login, Dashboard, All Jobs, Add Job, My Applications, Analytics.

**Status:** Phase 1 (foundation and secure login) is implemented. Jobs, applications, dashboard metrics and analytics arrive in later phases; until then those screens show only a heading. Work proceeds one phase at a time with explicit owner approval.

## Documents
- [phases.md](phases.md) – five-phase roadmap and completion criteria
- [architecture.md](architecture.md) – architecture, data flow, security boundaries
- [techstack.md](techstack.md) – technologies and verified commands
- [docs/setup](docs/setup/README.md), [docs/testing](docs/testing/README.md), [docs/deployment](docs/deployment/README.md)

## Quick start
```bash
npm install
cp .env.example .env.local   # optional locally; see docs/setup/README.md
npm run dev                  # http://localhost:3000
```
Without env vars, development uses documented prototype access codes and a dev-only session secret. Production refuses to start sessions without `SESSION_SECRET` and fails closed without access codes.

## Commands
`npm run dev`, `npm run build`, `npm start`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e`.

## Layout
- `assets/` – original reference screenshots and photos (never modified)
- `public/assets/` – browser-served copies of the profile photos
- `src/app` – pages and route handlers; `src/components`; `src/lib` (`auth`, `validation`); `src/config`
- `tests/` – `unit`, `integration`, `e2e`

## Security notes
Access codes are verified on the server only. Sessions are signed, HTTP-only cookies; identity is always taken from the validated session, never from browser-supplied names or IDs. Never commit `.env*` files or service-account JSON.
