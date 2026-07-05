# SETUP.md — external resources checklist

Things only you (the founder) can create. Each item names exactly what to make and
where to put it. Code is already scaffolded against these; everything else runs
locally without them.

## Pending

### 4. GitHub App (needed for Phase 1 live testing)

Create the app that receives webhooks and posts PR comments:

- [ ] Go to https://smee.io/new and copy your channel URL (webhook proxy for local dev).
- [ ] Go to https://github.com/settings/apps/new and create an app:
  - **Name:** `flowguard-dev-<yourname>` (must be globally unique)
  - **Homepage URL:** anything (e.g. the repo URL)
  - **Webhook URL:** your smee channel URL
  - **Webhook secret:** generate one (`openssl rand -hex 24`) and save it
  - **Repository permissions:**
    - Checks: **Read & write**
    - Commit statuses: **Read & write**
    - Contents: **Read-only**
    - Deployments: **Read-only**
    - Issues: **Read & write**
    - Pull requests: **Read & write**
    - Metadata: Read-only (forced)
  - **Subscribe to events:** Pull request, Deployment status, Push, Issue comment
- [ ] After creating: note the **App ID**, then **Generate a private key** (downloads a `.pem`).
- [ ] **Install the app** on your account, selecting the monorepo from step 1.
- [ ] Create `apps/api/.env` (see `apps/api/.env.example`):
  ```sh
  GITHUB_APP_ID=<app id>
  GITHUB_APP_PRIVATE_KEY_BASE64=$(base64 -i ~/Downloads/<downloaded>.pem)
  GITHUB_WEBHOOK_SECRET=<the webhook secret>
  FLOWGUARD_MASTER_KEY=$(openssl rand -hex 32)
  SMEE_URL=<your smee channel URL>
  ```

### 5. Vercel access token + bypass secret (needed for Phase 1 seed)

- [ ] Vercel → Account Settings → **Tokens** → create a token (scope: your team/account).
- [ ] Vercel → the demo project → Settings → **Deployment Protection** →
      **Protection Bypass for Automation** → generate, copy the secret.
      (If deployment protection is disabled the bypass secret is optional — still fine to create.)
- [ ] Run the seed script to bind repo ↔ Vercel project (exact command is printed in
      PROGRESS.md once you get here; it needs the project ID + team ID from the
      Vercel project settings).

### 6. Preview-environment payments (recommended before Phase 2)

- [ ] In the Vercel project env vars, override `MOCK_PAYMENTS=1` for the **Preview**
      environment only (keep `0` in Production). Until Phase 11 lands the typed
      Stripe payment step, replay flows on previews can't complete hosted Stripe
      Checkout — mock mode keeps buy/rip flows runnable on preview URLs.

## Done

- [x] **1. GitHub repository** — created and pushed (2026-07-05).
- [x] **2. Vercel project for the demo app** — `vercel-reviewer-demo-app.vercel.app`,
      env vars set, verified end-to-end incl. chaos flags (2026-07-05).
      Still needed from its settings: **project ID + team ID** for item 5.
- [x] **3. Stripe test keys** — `sk_test_…` live on the deployment with
      `MOCK_PAYMENTS=0`; full hosted-checkout purchase verified with the 4242 card
      (2026-07-05). Test cards: `4242 4242 4242 4242` (card),
      `4000 0027 6000 3155` (3DS challenge).

## Local development (no external resources needed)

```sh
pnpm install
pnpm db:up                        # Postgres :5433, Redis :6379, MinIO :9000/:9001
pnpm --filter @flowguard/db migrate
pnpm build && pnpm test
pnpm --filter @flowguard/demo-app dev   # http://localhost:3000
```

Local Postgres runs on **5433** to avoid colliding with the natively-installed
Postgres on 5432. MinIO console: http://localhost:9001 (minioadmin/minioadmin);
buckets `flowguard-artifacts` + `flowguard-recordings` are auto-created.
