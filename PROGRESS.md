# PROGRESS.md

_Resume file for working sessions. Updated at the end of every session._

## Current phase: **Phase 1 — ✅ COMPLETE (2026-07-08)**; next up: Phase 2 — Runner MVP

### Phase 1 live AC evidence (PR abhinav26966/vercel-reviewer#1)

- GitHub App `flowguard-dev-abhinav` (id 4237892) installed → installation webhook
  verified through smee → `installation_id 145154076` stored.
- Project seeded: `prj_862ymcrku4xal4` bound to Vercel `prj_TePAGdlaVuEH9N0WNoDBtYEBvhyp`
  / `team_rMutuXA9J2h2zIhlsY4pl2EB`.
- PR opened → `awaiting_deployment` run + pending status → Vercel preview success →
  run upgraded to `planning` + **ONE** sticky comment (id 4912456115) with preview URL.
- Second push → **same comment id edited in place** (`219c88f` → `41b0ff4`), one run
  row per SHA, statuses pending→success per push. Never a second comment. ✅
- PR merged → `pull_request.closed` cancelled all 3 open PR runs; PR row `merged`. ✅
- Main deployment → **base run created** (`run_teq7ghmvw1n2r8, branch=main`). ✅
  Required a live-found fix: Vercel sends `deployment.ref` = commit SHA (not branch);
  base membership now resolved via compare API (doc 06 §2 updated).
- **Protection bypass secret verified live** against the SSO-protected preview
  (302 without → cookie handshake → 200 with) and stored in the vault; project row
  `has_bypass=t`.
- `MOCK_PAYMENTS` split via CLI: Production=0 (real Stripe test mode), Preview=1
  (SETUP #6 done — replay flows can buy packs on previews pre-Phase-11).

### ⏳ One remaining external item (not Phase-blocking)

- **Vercel access token**: CLI minting is refused by Vercel (`403 Cannot create
  tokens for this app`) — tokens can only be created in the dashboard:
  https://vercel.com/account/settings/tokens → create → then
  `pnpm --filter @flowguard/api exec tsx --env-file=.env scripts/seed-project.ts
  --repo abhinav26966/vercel-reviewer --vercel-project prj_TePAGdlaVuEH9N0WNoDBtYEBvhyp
  --vercel-team team_rMutuXA9J2h2zIhlsY4pl2EB --vercel-token <TOKEN>`.
  Needed by Phase 3 (base-deployment lookup via Vercel API); Phase 2 runs without it.

## Phase 0 — ✅ COMPLETE (2026-07-05)

All acceptance criteria verified:

| AC | Evidence |
|---|---|
| `pnpm build && pnpm test` green | clean rebuild green; lint + typecheck green |
| demo-app runs locally | login → buy → inventory → open verified via curl + headless Chromium |
| demo-app runs on Vercel | `vercel-reviewer-demo-app.vercel.app` — login, **real Stripe test-mode Checkout completed with 4242 card**, canvas rip → `{packOpened:true, cardsRevealed:5}` on prod |
| chaos flags | prod: `?slow=1` buy 1.07s→2.82s; `?break=rip` → 500; `?blank=1` → `<main></main>` |

## Phase 1 task status

| Task | Status |
|---|---|
| 1. `apps/api` Fastify + `/webhooks/github` (raw-body HMAC verify, 401 on bad sig), delivery-id idempotency, handlers for `installation*`/`pull_request`/`deployment_status`/`issue_comment` | ✅ code + 19 tests |
| 2. `packages/vercel` deployments client (get by id/url, list by project+sha, project-binding check) | ✅ + 4 tests |
| 3. Project setup via script (`pnpm --filter @flowguard/api seed:project`), org/project rows, repo↔Vercel binding, encrypted token/bypass storage | ✅ (needs SETUP #5 inputs) |
| 4. deployment_status success → PR resolution → runs row (planning) → sticky comment (marker find-or-create, edit-in-place) → commit status | ✅ code + tests |
| 5. Base-branch deployment → base run row | ✅ code + tests |
| 6. PR closed → cancel runs; `/flowguard rerun` parsing | ✅ code + tests (execution wired in Phase 3) |

Also landed: `packages/github` (App auth, webhook verify, sticky-comment upsert, commit
status, comment renderer); envelope encryption in `packages/shared` (local master key,
KMS slot-in later); `webhook_deliveries` table (doc 08 updated in same commit).

## Phase 1 AC — ⏳ awaiting live test

> Open a PR on the demo repo → within seconds of Vercel finishing, exactly ONE comment
> with the correct preview URL; edits in place on second push. Base merge creates a
> base run row.

Comment/run/idempotency mechanics are unit-tested (edit-in-place, duplicate-delivery
skip, awaiting-run upgrade, multi-project filter). Live path needs founder actions:

1. **SETUP.md item 4**: smee channel + GitHub App (permissions/events listed there) + install on repo + `apps/api/.env`.
2. **SETUP.md item 5**: Vercel token + bypass secret.
3. Then:
   ```sh
   pnpm db:up && pnpm --filter @flowguard/db migrate
   pnpm --filter @flowguard/api dev            # terminal 1
   pnpm --filter @flowguard/api dev:webhooks   # terminal 2 (needs SMEE_URL in env)
   # install the GitHub App now (installation webhook lands) then:
   pnpm --filter @flowguard/api seed:project -- --repo <owner>/<repo> \
     --vercel-project <prj_...> --vercel-team <team_...> \
     --vercel-token <token> --bypass-secret <secret>
   # open a test PR touching examples/demo-app → watch the comment appear
   ```

## Deviations from docs (documented in-doc, same commit)

- doc 02 §1: trace-field nullability clarifications.
- doc 04 §1: `cvc` → `cvcRef`; `ExecuteFlowJob` embeds `spec`.
- doc 08: added `webhook_deliveries` (delivery-id idempotency ledger).
- GitHub App permissions beyond doc 06 §1 list: + Commit statuses RW (Phase 1 uses
  statuses API), + Issues RW (PR comments go through the issues API).
- Local Postgres on host port **5433** (native PG owns 5432 on founder's machine).

## Implementation notes for future sessions

- Zod v4 (`.prefault({})`, `z.iso.datetime()`, `z.url()`); TS 5.9.3, ESLint 9, Next 15.5, Vitest 4, Fastify 5, octokit 5.
- apps/api handlers take a `Store` interface (`src/store.ts`); tests use `test/fakes.ts`
  in-memory store — keep new handlers testable the same way.
- Webhook route ALWAYS 2xx after signature+idempotency (GitHub retries would replay
  side effects); handler errors are logged, not thrown.
- Vercel sets `deployment.ref` to the branch name — base-run detection keys off it.
- Demo-app cookie-state → Phase 11 needs server-side state (Vercel KV) for webhook AC.
- puppeteer-core + system Chrome is broken for input after redirects — use Playwright.
- Suggest `MOCK_PAYMENTS=1` on Vercel **Preview** env before Phase 2 (SETUP #6) so
  buy/rip flows run on previews before the Phase 11 payment step exists.

## Open questions for the founder

- None blocking. Phase 1 live AC needs SETUP.md items 4–5.

## Next session

- **Phase 2 — Runner MVP** (doc 09): `apps/runner` on the Playwright image,
  deterministic replay loop (navigate/click/type/press/waitFor, locator stacks,
  networkidle/navigation/timeout settles, dom/url assertions, one retry, failure
  bundle), Vercel bypass cookie mode (secret already in vault), artifacts to MinIO,
  BullMQ `runs` queue + abort tokens, handwritten `login.flow.json` +
  `inventory.flow.json`, CLI `pnpm flow:run <spec> <url>`.
- No new founder resources needed for Phase 2 (bypass ✓, MinIO local ✓). The Vercel
  token (dashboard-only) unblocks Phase 3 base resolution.
