# FlowGuard

GUI-level PR reviewer for Vercel preview deployments: replay user-defined, named
flows against every PR preview, compare against the base branch, and post a verdict
with video proof — before merge.

- **Docs:** [`docs/`](docs/) — start with [`docs/00-project-overview.md`](docs/00-project-overview.md)
- **Build plan:** [`docs/09-build-plan.md`](docs/09-build-plan.md) · **Progress:** [`PROGRESS.md`](PROGRESS.md)
- **External-resource checklist:** [`SETUP.md`](SETUP.md)

## Layout

```
packages/schemas    Zod contracts: RecordingTrace, FlowSpec, RunFlowResult, … (doc 02)
packages/db         Drizzle schema + migrations (doc 08)
packages/shared     ids, typed errors, redacting pino logger
examples/demo-app   PackDemo — the permanent test target (login, shop, 3D pack rip)
docs/               product & architecture docs (source of truth)
```

## Quickstart

```sh
pnpm install
pnpm db:up                              # Postgres :5433, Redis, MinIO (Docker)
pnpm --filter @flowguard/db migrate
pnpm build && pnpm test
pnpm --filter @flowguard/demo-app dev   # login: default@demo.dev / demo1234
```
