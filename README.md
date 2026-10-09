# JobSync

A private job-tracking web app shared by three members: **Anni** (blue), **Lukky** (yellow) and **Rishii** (red).
Screens: Login, Dashboard, All Jobs, Add Job, My Applications, Analytics.

**Status:** repository preparation complete; application code has not been started. Implementation proceeds one phase at a time, each requiring explicit owner approval.

## Documents
- [phases.md](phases.md) – five-phase roadmap and completion criteria
- [architecture.md](architecture.md) – architecture, data flow, security boundaries
- [techstack.md](techstack.md) – approved and proposed technologies

## Layout
- `assets/` – original reference screenshots and profile photos (never modified)
- `public/assets/` – browser-served copies of profile photos
- `src/` – application source (`app`, `components`, `lib`, `types`, `config`)
- `tests/` – unit, integration and e2e tests
- `docs/` – setup, testing and deployment guides

## Configuration
Copy `.env.example` to `.env.local` and fill in values. Never commit env files or service-account JSON.

## Development commands
None yet: the Next.js project is created in Phase 1, at which point verified commands are documented here.
