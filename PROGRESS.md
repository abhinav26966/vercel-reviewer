# PROGRESS.md

_Resume file for working sessions. Updated at the end of every session._

## Current phase: **Phase 4 — Credentials, sessions, redaction — ✅ AC PASSED (2026-07-08)**; next up: Phase 5 — Recorder extension

### Phase 4 AC evidence (live on PR #3)

1. **storageState auth, login once per target**: worker log shows the Login flow
   executed once per (persona, deployment), cached to S3 + session_states, and
   subsequent flows logging "storageState cache hit — login skipped".
2. **Wrong project password** → Inventory/Rip 🟣 `login failed on this preview:
   credentials may be wrong, or this PR may use a separate database — provide
   [PR-scoped credentials](dashboard link), then comment /flowguard rerun`;
   Login flow ⬜ already_broken_on_base (fails identically on base — honest).
3. **PR-scoped credentials via dashboard UI** (Playwright-driven form) +
   `/flowguard rerun` → all ✅ (head resolved PR scope w/ dataBranchDiffers=true,
   base stayed on project defaults — doc 07 §3 hierarchy per target).
4. **Byte-scan**: every artifact in MinIO (videos, traces, HARs incl. the login
   POST body, consoles, storageStates) + api/worker logs — ZERO hits for the
   password (plain, url-encoded, base64). The scan caught a real pre-Phase-4
   leak first (see lessons), proving it works.
5. Bonus: closing PR #3 auto-expired its PR-scoped credential set via the real
   webhook (expires_at set).

Built: vault resolution in runner only (+ redaction registration before use),
login-once session manager (no-artifact context), CDP insertText secret typing
(+ origin guard, tracing disabled for secret specs), HAR post-processor,
credential CRUD + per-target resolution + secretRefs, synthetic login_failed for
missing credentials, dashboard v0 (:3100), goto-retry for freshly-READY previews.
23 new tests (132 total).

### Phase 4 lessons (hard-won)

- **A zombie Phase-3 worker** (pkill pattern missed tsx's real argv) competed on
  the queue and poisoned half a run with pre-secrets code. Always verify worker
  process count; runner processes should assert a build/version tag (Phase 13).
- **Deterministic BullMQ jobIds + retained completed jobs = reruns replay stale
  results.** enqueueFlowJob now evicts finished jobs squatting on the id.
- **Rerun must reuse the existing run row** (idempotency index forbids a second
  run for the same sha+deployment); run_flow_results upsert within the same run.
- **The scan test caught a real leak**: the demo app printed its own password on
  the login page ("Try … / demo1234") and a pre-redaction aria snapshot stored
  it. Hint removed; pre-Phase-4 artifacts purged. Even so, the NEW pipeline
  redacts page-content secrets from bundles via the registry.
- **Freshly-READY previews can be unreachable for ~60s** (edge propagation);
  initial navigation now retries 3× with backoff.
- The orchestrator bakes storageStateKey at planning; the runner re-checks
  session_states at execution so login truly runs once per target.

## Phase 3 — Orchestrated PR runs — ✅ AC PASSED (2026-07-08)

### Phase 3 AC evidence (live on PR #2, abhinav26966/vercel-reviewer)

- **Regression push** (`b88d1dc`, a real code change 500-ing /api/packs/open):
  sticky comment showed **Login ✅ 4.6s · Inventory ✅ 3.8s · Buy & Rip 🔴 broken**
  with `stuck at step s6 "Rip open the pack": text "1" !~ /^0$/ · POST
  /api/packs/open → 500` + signed [video][trace][screenshot] links; commit status
  `failure: 1 flow broken: Buy & Rip (DOM-only)`. Compared against merge base
  `40eecd0`; base ran fresh (cache 0/3).
- **Fix push** (`b3faa47`): the SAME comment (id 4913215935) flipped to all ✅;
  **base cache hit 3/3** — head run 14s vs 39s. Status `success: all 3 flows passing`.
- **Cancellation**: verified live twice — the orphaned `1f981c2` run and a
  duplicate-deployment run for `b22a8dd` were both `cancelled` with
  `superseded_by` set + runner abort keys. (With the base cache, runs finish in
  ~15s — faster than Vercel build skew, so back-to-back pushes usually serialize;
  the supersede path covers every genuinely-overlapping case.)
- Artifact links: GET /artifacts HMAC check → 302 presigned MinIO URL; tampered
  sig → 403.
- 8 runs total on PR #2; PR closed unmerged (test artifact), branch deleted.

Built: orchestrator state machine (planning → resolving_base → executing →
reporting), merge-base via compare API, base deployment resolution (exact SHA →
nearest READY production ancestor), BullMQ fan-out/fan-in with deterministic job
ids, base_result_cache, pre-LLM comparator, verdict-table renderer, HMAC-signed
artifact redirect, /flowguard rerun re-orchestration, seed-flows script,
supersede-with-ordering. 20 new hermetic tests (109 total).

### Phase 3 lessons

- MOCK_PAYMENTS=1 now in Production too (base runs execute buy against prod) —
  **revert to 0 when Phase 11 lands the typed Stripe step** (SETUP note).
- Vercel skips prod builds for commits not touching the app root dir (CANCELED
  state) — base resolution's nearest-ancestor fallback covers it, but a fresh env
  var needs a commit touching examples/demo-app to take effect.
- TS control-flow: an unconditional early `return` kills null-narrowing below it —
  the first regression commit broke the BUILD (pipeline correctly stayed silent:
  no success event, no run).
- NEVER `git add -A` on a side branch while main has uncommitted work — it swept
  api fixes into a test commit (recovered via git checkout <sha> -- paths).

## Phase 2 — Runner MVP — ✅ AC PASSED (2026-07-08)

### Phase 2 AC evidence (all against the SSO-protected preview `…6u3z7fx9d…`, bypass via vault secret)

| Flow | Result | Artifacts in MinIO |
|---|---|---|
| login.flow.json | ✅ passed (2.8s) | video, trace.zip, network.har, console.json |
| inventory.flow.json | ✅ passed (3.2s) | full set |
| rip.flow.json (buy via mock payments + canvas click) | ✅ passed (6.8s), `POST /api/packs/open → 200` | full set |
| rip-broken.flow.json (`?break=rip`) | 🔴 failed at **s6**, class `assertion` | full set + `steps/s6/failure.png` + failure-bundle.json (500s in step network window, console errors, pending requests, aria snapshot) |

Built: `apps/runner` — deterministic replay loop (navigate/click/type/press/waitFor/
select/scroll, locator stacks w/ 2.5s per-locator + 8s budget, one deterministic
retry), settle strategies networkidle/navigation/timeout, polling dom|url assertions,
origin guard + host-scoped Vercel bypass header injection (cookie handshake),
failure bundles, S3/MinIO artifact store, BullMQ `runs` worker with redis abort keys,
`flow:run` CLI, Dockerfile (build-verified in Phase 13), 14 browser-level tests
(CI now installs chromium).

Vercel access token: stored in vault (2026-07-08); verified via
`deploymentBelongsToProject → true`. SETUP item 7 ✅ — no external items pending.

### Phase 2 lessons (keep in mind)

- Clicking a canvas right after `networkidle` misses: the r3f scene needs ~1–2s to
  become raycast-ready under SwiftShader. Interim: explicit warm-up step (`waitFor` +
  `timeout` settle) in canvas specs; real fix is `animationQuiescence` (Phase 12).
- DOM assertions must POLL to their deadline (fetch responses land after settle).
- Retrying a click that half-succeeded can double-fire side effects (two 500s in the
  broken run; the transient `hidden` pass on open-error). Revisit retry semantics for
  non-idempotent steps in Phase 7.

## Phase 1 — ✅ COMPLETE (2026-07-08)

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

- **Phase 5 — Recorder extension + DevTools import** (doc 09): Chrome MV3
  extension (popup UI, chrome.debugger service worker, content-script event
  capture w/ locator stacks + canvas coords, CDP screenshots + a11y + network
  windows, extension-side redaction), trace upload endpoint, DevTools Recorder
  JSON import. AC: record buy&rip on the demo app; trace validates against the
  Zod schema; password appears as «redacted:password».
- No new founder resources needed (recording happens against the deployed demo).
