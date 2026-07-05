# SETUP.md — external resources checklist

Things only you (the founder) can create. Each item names exactly what to make and
where to put it. Code is already scaffolded against these; everything else runs
locally without them.

## Pending

### 1. GitHub repository (needed before Phase 1)

- [ ] Create a GitHub repo (e.g. `flowguard`) and push this monorepo to it:
  ```sh
  git remote add origin git@github.com:<you>/flowguard.git
  git push -u origin main
  ```
  PRs against this repo double as demo-app PRs in later phases (the Vercel project
  below builds `examples/demo-app` from it).

### 2. Vercel project for the demo app (Phase 0 AC: "demo-app runs on Vercel")

- [ ] In Vercel: **Add New → Project**, import the GitHub repo from step 1.
- [ ] Set **Root Directory** to `examples/demo-app` (framework: Next.js autodetects;
      pnpm workspace is detected from the repo-root lockfile).
- [ ] Environment variables (Project → Settings → Environment Variables):
  - `SESSION_SECRET` — any long random string (e.g. `openssl rand -hex 32`)
  - `MOCK_PAYMENTS` = `1` (until Stripe is configured)
  - `DEMO_PASSWORD` — optional; defaults to `demo1234`
- [ ] Deploy, then verify manually on the production URL:
  login `default@demo.dev` / `demo1234` → buy → inventory → open;
  chaos flags `/shop?slow=1`, `/open?break=rip`, `/inventory?blank=1`.
- [ ] Note the Vercel **project ID** and **team ID** (Settings → General) — Phase 1
      needs them for the repo↔project binding.

### 3. Stripe test keys (not needed until Phase 11, but cheap to do now)

- [ ] Create/reuse a Stripe account → Developers → API keys → **test mode**.
- [ ] Put `STRIPE_SECRET_KEY` (`sk_test_…`) in the Vercel project env (and in
      `examples/demo-app/.env.local` if you want real Checkout locally), and set
      `MOCK_PAYMENTS=0`.
- Test cards: `4242 4242 4242 4242` (card), `4000 0027 6000 3155` (3DS challenge).

### 4. Coming in Phase 1 (listed for visibility, don't do yet)

- GitHub App creation (webhook secret, private key, permissions per doc 06 §1).
- Vercel access token + **Protection Bypass for Automation** secret for the
  demo project (Vercel → Project → Settings → Deployment Protection).

## Done

- (nothing yet)

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
