# PROGRESS.md

_Resume file for working sessions. Updated at the end of every session._

## Current phase: **Phase 1 — Webhook plumbing** (code complete; live AC needs GitHub App — SETUP.md items 4–5)

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

- Founder runs SETUP 4–5 → live-test Phase 1 AC (single sticky comment, in-place edit,
  base run row) → then **Phase 2 — Runner MVP** (doc 09): `apps/runner`, deterministic
  replay of handwritten login/inventory/rip specs against the real preview, artifacts
  to MinIO, BullMQ queue.
