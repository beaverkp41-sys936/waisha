# Waisha — agent notes

Multi-tenant transporter portal for Tanzania (wards Mkoa/Wilaya/Kata, NIDA, +255 phones, OSRM road routing).

## Commands

Turborepo + pnpm 9. Run from the repo root:

- `pnpm dev` — api (Fastify, port 4000) + web (Next.js, port 3000)
- `pnpm build` / `pnpm typecheck` / `pnpm test` — across all packages
- `pnpm migrate` / `pnpm seed` — database scripts (Supabase Postgres; never edit prod tables by hand)

## Layout

- `api/` — Fastify + Zod + pg. Routes in `src/routes/`, one file per module (auth, drivers, fleet, licence, payments, routes...).
- `web/` — Next.js App Router; portal pages live under `web/app/app/` with `api-client.ts` handling tokens/refresh.
- `packages/` — shared code.

## Conventions

- Tenant isolation via `withTenant` (api/src/db/pool.ts); PII (NIDA, phones) stored encrypted with search hashes (api/src/util/crypto.ts) — never return raw PII from list endpoints.
- Every write goes through `writeAudit` (api/src/audit/audit.ts).
- Drivers PUT is presence-based: absent key keeps the column, explicit null clears it; blank NIDA/phone in the UI means "keep stored value".
- Commit style: `type(scope): summary`, lowercase (e.g. `feat(drivers): ...`). Deploy: Render from `main`; DB is Supabase.
