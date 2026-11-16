# ADR-0001: Stack and repository layout

- Status: Accepted (approved by the project owner before M0–M2)
- Date: 2026-11-16

## Decision

| Concern | Choice |
|---|---|
| Monorepo | pnpm workspaces |
| Frontend | Next.js + TypeScript (`apps/web`) |
| Backend | Fastify, a separate read-only API (`apps/api`) |
| Shared code | `packages/shared`: Zod schemas, canonical draw model, matching engine, GLO data contracts |
| Database / ORM | PostgreSQL + Drizzle. **Not yet installed**; arrives with the schema milestone (M3) |
| Validation | Zod (v4) |
| Testing | Vitest + fast-check |
| CI | GitHub Actions: format check, lint, typecheck, test, web build |
| Explicitly excluded | Redis, Kafka, Kubernetes, extra microservices |

## Deviations from the original roadmap (docs/planning/implementation-roadmap.md)

- **One package instead of three.** The roadmap listed `packages/domain`, `packages/glo-adapter` and `packages/validation` separately. As requested, the domain model, matcher, validation and the GLO **schemas and mapper** all live in `packages/shared` for now. The GLO **HTTP client** is still not written (live ingestion is M4+). Split the package only if it grows unwieldy.
- **No `apps/worker` yet.** It is created when ingestion starts.

## Toolchain pins and why

- **TypeScript 6.0.x, not 7.x.** typescript-eslint 8 supports TypeScript `<6.1`.
- **`@types/node` 22.x**, to match the Node 22 runtime (`.nvmrc`).
- **Module resolution `Bundler`.** Workspace packages are consumed as TypeScript source (`exports: ./src/index.ts`) by Next.js (`transpilePackages`), Vitest and tsx. This avoids a build step for internal packages.

## Matching-engine design decisions

1. **Ticket numbers are strings matching `^[0-9]{6}$`.** JS numbers are rejected, because they lose leading zeros.
2. **Category semantics are static:** match type, digit count and names. **Prize amounts are never static.** They are per-draw data and may be `null`. A draw with any unknown winning amount reports a `null` total.
3. **A draw's prize structure is inferred from its own published data** (the counts of 3-digit prizes), never from its date. The changeover date has not been verified yet.
4. **The matcher uses the near1 numbers GLO actually published.** It never computes them. `adjacentNumbers()` is used only by validation. At the 000000/999999 boundary, validation emits a warning because GLO's rule there is unverified.
5. **All matching categories are returned, and prizes accumulate.**
6. **The mapper drops GLO-reported amounts for legacy-structure draws by default** (`legacyAmounts: 'omit'`), because the research found them suspect.
