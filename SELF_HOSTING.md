# Self-hosting FlowGuard (free)

Run the entire FlowGuard stack — api, runner, dashboard, Postgres, Redis,
object storage — on one machine with one command. Total cost: **$0/month**
on Oracle Cloud's always-free tier (or any box you already have), plus your
own inference-API usage (~$0.01–0.05 per reviewed PR with Claude Haiku).

Requirements: Docker with Compose v2, 4GB+ RAM (8GB+ recommended for
canvas-heavy apps), a public HTTPS URL for GitHub webhooks (§4 gives you one
for free).

## 1. Get a free machine (skip if you have one)

**Oracle Cloud always-free tier** is the most generous genuinely-free VM:
up to 4 ARM (Ampere) OCPUs / 24GB RAM, free forever.

1. Sign up at cloud.oracle.com (card required for identity, not charged).
2. Create an instance: **Ampere A1.Flex**, 2 OCPU / 8GB (stays within the
   free allowance), image **Ubuntu 24.04**, add your SSH key.
3. In the instance's subnet **Security List**, add ingress rules for TCP
   80 and 443 (source 0.0.0.0/0).
4. SSH in and install Docker:
   ```sh
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER && exit   # reconnect
   ```

> ARM note: everything in the stack (Playwright, Postgres, Redis, MinIO,
> node:22) publishes arm64 images — no x86 emulation needed.

## 2. Create your GitHub App (each instance has its own)

Your instance talks to GitHub as its own App — you control the keys.

1. GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.
2. Name: anything (e.g. `flowguard-<you>`), Homepage: your repo.
3. **Webhook URL**: `https://<your-api-domain>/webhooks/github`
   (finish §4 first if you don't have the domain yet — you can save the App
   and edit this later). **Webhook secret**: `openssl rand -hex 20`, save it.
4. **Repository permissions**: Contents *(read)*, Pull requests *(read &
   write)*, Checks *(read & write)*, Commit statuses *(read & write)*,
   Deployments *(read)*.
5. **Subscribe to events**: Pull request, Push, Deployment status.
6. Create, then: note the **App ID**, generate a **private key** (.pem
   downloads), and **Install App** on the repos you want reviewed.

## 3. Configure and launch

```sh
git clone https://github.com/abhinav26966/vercel-reviewer flowguard && cd flowguard
cp .env.production.example .env.production
# fill in .env.production — every field is documented inline
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

First build takes ~10 min (it compiles everything and pulls Playwright).
Check health:

```sh
curl http://localhost:8787/healthz     # → {"ok":true}
docker compose -f docker-compose.prod.yml logs api worker --tail 20
```

## 4. Free HTTPS (GitHub webhooks need a public URL)

Point a DNS A-record (any domain you own, or a free subdomain from
duckdns.org) at your machine, set in `.env.production`:

```
API_DOMAIN=flowguard-api.yourdomain.com
DASHBOARD_DOMAIN=flowguard.yourdomain.com
PUBLIC_API_URL=https://flowguard-api.yourdomain.com
PUBLIC_DASHBOARD_URL=https://flowguard.yourdomain.com
```

then enable the bundled Caddy proxy (auto-provisions Let's Encrypt certs):

```sh
docker compose -f docker-compose.prod.yml --env-file .env.production --profile proxy up -d --build
```

Put the API URL into your GitHub App's webhook field (§2.3). Done.

## 5. Onboard your app

Follow **ONBOARDING.md** — bind your Vercel project (token + protection
bypass), add test-account credentials, record a flow, open a PR, get a
verdict. ~15 minutes.

## Operations

- **Update**: `git pull && docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build` (migrations run automatically before the api starts).
- **Backup** (Postgres is the state that matters; artifacts are re-creatable):
  ```sh
  docker compose -f docker-compose.prod.yml exec postgres pg_dump -U flowguard flowguard | gzip > flowguard-$(date +%F).sql.gz
  ```
  Cron it daily; copy off-machine (e.g. `rclone` to any free object storage).
- **Scale reviews**: one worker container executes one flow at a time. More
  parallelism: `docker compose -f docker-compose.prod.yml up -d --scale worker=3`.
- **Logs**: `docker compose -f docker-compose.prod.yml logs -f api worker`.
- **Keep the master key safe**: `FLOWGUARD_MASTER_KEY` encrypts every stored
  credential/token. Store a copy in your password manager.

## Costs, honestly

| Item | Cost |
|---|---|
| Oracle always-free VM (or your own box) | $0 |
| Postgres / Redis / MinIO (in the compose stack) | $0 |
| TLS via Caddy + Let's Encrypt | $0 |
| Inference (your OpenRouter/Anthropic key) | ~$0.01–0.05 per reviewed PR* |

*FlowGuard only calls models at flow-authoring time, on failures (heal +
judge), and for canvas/vision assertions — never per-step on green runs. A
quiet repo costs cents per month.
