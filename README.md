# Lekvero

An **informational** Thai Government Lottery (สลากกินแบ่งรัฐบาล) results platform. It shows results, lets people browse past draws and lets them check their numbers.

> **No ticket sales, betting, payments or gambling features**, now or later.
> **Public launch is blocked** until the Government Lottery Office (GLO) clarifies whether its data may be used this way. See [`docs/legal/glo-data-usage-inquiry-draft.md`](docs/legal/glo-data-usage-inquiry-draft.md). Local development uses archived fixtures only.

## Status

| Milestone                               | State                                      |
| --------------------------------------- | ------------------------------------------ |
| Research & architecture (`docs/`)       | Done, reviewed                             |
| M0: data contracts & fixtures           | Done (inquiry email drafted, **not sent**) |
| M1: repository foundation               | Done                                       |
| M2: matching engine                     | Done                                       |
| M3: PostgreSQL schema, lifecycle, roles | Done (not yet committed; awaiting review)  |
| M4+: ingestion, public API, web UI      | Not started                                |

## Layout

```
apps/
  api/        Fastify read-only API (currently only GET /health)
  web/        Next.js frontend (placeholder page)
packages/
  shared/     Zod schemas, canonical draw model, matching engine, GLO data contracts
  db/         Drizzle schema, SQL migrations, import/verification repositories (PostgreSQL 17)
fixtures/glo/v1/   Archived GLO API responses + synthetic malformed cases (see its README)
docs/              research, architecture, roadmap, ADRs, legal drafts
scripts/           fixture tooling (Python 3, stdlib only)
```

## Local development

Requirements: Node 22 (see `.nvmrc`) and pnpm 10 (`corepack enable` picks up the version in `package.json`).

```bash
pnpm install
cp .env.example .env           # optional; defaults work

pnpm test                      # all Vitest projects (shared + api)
pnpm test:watch
pnpm lint
pnpm typecheck
pnpm format                    # or format:check

pnpm --filter @lekvero/api dev # http://127.0.0.1:4000/health
pnpm --filter @lekvero/web dev # http://localhost:3000
```

No test or dev command contacts GLO. Live ingestion is not implemented.

### Local database (PostgreSQL 17)

See [`docs/runbooks/database.md`](docs/runbooks/database.md) for the full procedure. Short version:

```bash
docker compose up -d postgres                 # needs POSTGRES_PASSWORD in .env
set -a; . ./.env; set +a
pnpm --filter @lekvero/db db:bootstrap-roles  # admin: roles + database
pnpm --filter @lekvero/db db:migrate          # explicit; never on app startup
pnpm --filter @lekvero/db db:seed:fixtures    # optional, LEKVERO_ENV=local only
pnpm test:db                                  # DB integration tests (DATABASE_URL = admin URL)
pnpm db:verify-migrations                     # offline migration safety checks
```

Results move through `PENDING → VALIDATED → VERIFIED` (or `QUARANTINED` / `REJECTED`).
A valid import is only **VALIDATED**; publishing requires recorded official evidence.
Design: [`docs/architecture/database-design.md`](docs/architecture/database-design.md), [ADR-0002](docs/adr/0002-database-design-revisions.md).

## Using the matching engine

```ts
import {
  GloByDateEnvelopeSchema,
  mapGloDraw,
  validateDrawResult,
  checkTicket,
} from '@lekvero/shared';

const env = GloByDateEnvelopeSchema.parse(json); // archived GLO response
const draw = mapGloDraw(env.response!.result); // canonical DrawResult
if (!validateDrawResult(draw).ok) throw new Error('invalid draw');
checkTicket(draw, '000079'); // → { isWinner, wins: [...], totalAmountBaht }
```

Rules the engine follows:

- Tickets are six-digit **strings**, and leading zeros are kept.
- Every matching category is returned, and prizes add up.
- Prize categories come from the draw's own prize structure. Two structures are supported: legacy (4 × last-3) and modern (front-3 + back-3).
- Amounts come only from the draw data, and may be `null`. Current amounts are never assumed for historical draws.

## Licence of data

GLO's catalogue labels the results dataset _Creative Commons Non-Commercial (Any)_. The fixtures are kept for development and testing only. Do not redistribute them.
