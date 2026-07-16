# DEPLOY.md — production deployment (Fly.io)

> **Free alternative:** the whole stack also runs on a single free machine via
> `docker-compose.prod.yml` — see **SELF_HOSTING.md** ($0/month on Oracle's
> always-free tier). This file covers the managed Fly.io path (~$15–30/month,
> less to operate, per-service scaling). Both use the same images.

One-time setup the founder runs by hand; after this, every push to `main` that
passes CI auto-deploys (`.github/workflows/ci.yml` → `deploy` job).

Topology (doc 01 §2):

| Piece | Where | Why |
|---|---|---|
| api + orchestrator | Fly app `flowguard-api` | always-on webhook receiver, runs migrations on deploy |
| runner worker | Fly app `flowguard-worker` | Playwright image, scale by count |
| Postgres | Fly Managed Postgres | `DATABASE_URL` |
| Redis (BullMQ) | Upstash via Fly | `REDIS_URL` |
| Artifacts (S3) | Tigris via Fly | videos/traces/screenshots |
| dashboard | Vercel | it's a Next.js app; set `NEXT_PUBLIC_API_URL` |

Estimated cost at founder scale: ~$15–30/month (1 api VM, 1 worker VM,
smallest Postgres/Redis tiers; Tigris pay-per-use).

## 1. Install flyctl and create the apps (5 min)

```sh
brew install flyctl && fly auth login

fly apps create flowguard-api
fly apps create flowguard-worker
```

If you pick different names, update `app = …` in `infra/fly/fly.api.toml` /
`fly.worker.toml` and `PUBLIC_API_URL` in the api toml.

## 2. Provision data stores (10 min)

```sh
# Postgres — save the DATABASE_URL it prints
fly mpg create --name flowguard-db --region iad

# Redis — save the REDIS_URL it prints
fly redis create --name flowguard-redis --region iad

# S3 (Tigris) — creates credentials; run once per bucket
fly storage create --name flowguard-artifacts --app flowguard-api
fly storage create --name flowguard-recordings --app flowguard-api
```

`fly storage create` sets the Tigris `AWS_*` secrets on the app automatically —
FlowGuard reads `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` instead, so copy the
printed key pair into the secrets below.

## 3. Set secrets (5 min)

Values come from your existing `apps/api/.env` (the local dev file) — same
names, production values. Never commit these.

```sh
fly secrets set -a flowguard-api \
  DATABASE_URL="postgres://…" \
  REDIS_URL="redis://…" \
  FLOWGUARD_MASTER_KEY="$(openssl rand -hex 32)" \
  GITHUB_APP_ID="4237892" \
  GITHUB_APP_PRIVATE_KEY_BASE64="…" \
  GITHUB_WEBHOOK_SECRET="…" \
  S3_ACCESS_KEY_ID="…" S3_SECRET_ACCESS_KEY="…" \
  INFERENCE_API_KEY="sk-or-…" \
  INFERENCE_ANALYZE_MODELS="anthropic/claude-haiku-4.5" \
  INFERENCE_GROUNDING_MODELS="anthropic/claude-haiku-4.5" \
  INFERENCE_JUDGE_MODELS="anthropic/claude-haiku-4.5"

fly secrets set -a flowguard-worker \
  DATABASE_URL="postgres://…" \
  REDIS_URL="redis://…" \
  FLOWGUARD_MASTER_KEY="<same value as the api>" \
  S3_ACCESS_KEY_ID="…" S3_SECRET_ACCESS_KEY="…" \
  INFERENCE_API_KEY="sk-or-…" \
  INFERENCE_ANALYZE_MODELS="anthropic/claude-haiku-4.5" \
  INFERENCE_GROUNDING_MODELS="anthropic/claude-haiku-4.5"
```

⚠️ `FLOWGUARD_MASTER_KEY` must be identical on api and worker (both decrypt
vault secrets). Generating a NEW key means re-entering all credentials/tokens
in the dashboard — the old ciphertexts become unreadable. That is the right
move for production (fresh vault), just expect to re-run project setup.

## 4. First deploy (5 min)

From the repo root:

```sh
fly deploy -c infra/fly/fly.api.toml      # runs DB migrations, then starts
fly deploy -c infra/fly/fly.worker.toml
curl https://flowguard-api.fly.dev/healthz   # → {"ok":true}
```

## 5. Point GitHub + Vercel at production (5 min)

1. GitHub App settings → **Webhook URL** →
   `https://flowguard-api.fly.dev/webhooks/github` (replaces smee). Keep the
   same webhook secret.
2. Deploy `apps/dashboard` to Vercel; set env
   `NEXT_PUBLIC_API_URL=https://flowguard-api.fly.dev`. Put its URL into
   `PUBLIC_DASHBOARD_URL` in `fly.api.toml` and redeploy the api.
3. Re-run the project seed against production (creates the project row, binds
   Vercel token/bypass — command in PROGRESS.md, with production
   `DATABASE_URL`), or add the project via the dashboard.

## 6. Enable continuous deploy (2 min)

```sh
fly tokens create deploy -x 999999h   # org-scoped deploy token
gh secret set FLY_API_TOKEN           # paste it
```

Every green push to `main` now deploys api (with migrations) then worker.
Without the secret, the deploy job is a silent no-op — CI stays green.

## 7. Production validation (the two remaining Phase-13 ACs)

- **Soak**: open a PR on the demo repo, confirm the verdict comment comes from
  the Fly deployment (webhook → run → comment, no smee). Then run the Phase-7
  flake soak against production: 10× re-orchestrations of a green run
  (`apps/api/scripts/soak.ts` pointed at the production DATABASE_URL/REDIS_URL)
  — target: 0 false positives.
- **Stranger onboarding**: hand ONBOARDING.md + the dashboard URL to someone
  who hasn't seen the repo; they should reach a PR verdict in <15 min. Time it;
  every stumble is an ONBOARDING.md bug.

## Scaling notes

- More PR throughput → `fly scale count 3 -a flowguard-worker`. Per-project
  fairness is already enforced by the orchestrator.
- Queue-depth autoscaling (later): superfly/fly-autoscaler with a BullMQ
  waiting-count metric.
- The api is stateless (all state in PG/Redis/S3) — `fly scale count 2 -a
  flowguard-api` is safe; BullMQ schedules are idempotent by job id.
