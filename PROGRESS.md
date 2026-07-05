# PROGRESS.md

_Resume file for working sessions. Updated at the end of every session._

## Current phase: **Phase 0 — Foundation & demo target** (code complete; awaiting founder-side Vercel deploy)

## Phase 0 task status

| Task | Status |
|---|---|
| 1. Monorepo scaffold (pnpm + Turborepo, TS strict, ESLint 9 flat, Prettier, Vitest, CI workflow) | ✅ |
| 2. `packages/schemas` — Zod for RecordingTrace, FlowSpec, RunFlowResult, ExecuteFlowJob, ConfigBundle, Verdict (+ JudgeOutput, ProjectSettings); fixture round-trip tests | ✅ 23 tests |
| 3. `packages/db` — Drizzle schema (all 20 doc-08 tables), generated migration, docker-compose (Postgres 5433 / Redis / MinIO) | ✅ migration applied to real PG |
| 4. `packages/shared` — prefixed-nanoid ids, typed errors, pino logger + RedactionRegistry (registry functional; artifact/HAR/prompt sink wiring lands Phases 4/6) | ✅ 8 tests |
| 5. `examples/demo-app` — login, shop+Stripe/mock, inventory, r3f pack-rip canvas, `window.__flowState`, chaos flags | ✅ locally; ⏳ Vercel deploy (SETUP.md #2) |

## Phase 0 acceptance criteria

| AC | Evidence |
|---|---|
| `pnpm build && pnpm test` green | 4/4 build tasks; 37 tests passing (schemas 23, shared 8, db 2, demo-app 4); lint + typecheck green |
| demo-app runs locally | verified: login → buy → inventory → open, via curl AND headless Chromium (Playwright) |
| demo-app runs on Vercel | ⏳ **founder action — SETUP.md item 2** |
| chaos flags verified | `?slow=1`: buy 0.47s → 1.81s; `?break=rip`: POST /api/packs/open → 500, DOM error shown, `__flowState` stays `{packOpened:false, cardsRevealed:0}`; `?blank=1`: `<main></main>`, zero pack-cards |
| canvas + state SDK | headless click on canvas center → rip animation → 5 card meshes; `window.__flowState` ended `{packOpened:true, cardsRevealed:5}` (screenshots in session scratchpad) |

## Deviations from docs (all documented in the docs themselves, same commit)

- doc 02 §1: nullability clarifications for trace fields (`target` null on navigation events, throttled screenshots null, `newTab`).
- doc 04 §1: payment `cvc` plaintext → `cvcRef` secret reference (aligns with doc 07 §4 / doc 08); `ExecuteFlowJob` embeds the full `spec` (stateless runners).
- Local Postgres mapped to host port **5433** (native Postgres already owns 5432 on the founder's machine).

## Implementation notes for future sessions

- Zod is v4 (`.prefault({})` for object defaults, `z.iso.datetime()`, `z.url()`).
- Pinned majors: TS 5.9.3, ESLint 9, Next 15.5, Vitest 4, React 19, Turbo 2, Drizzle 0.45.
- Demo-app state lives in the signed session cookie (no DB → works on Vercel serverless).
  **Phase 11 will need server-side state** for webhook-attribution testing (a webhook
  can't update a cookie) — planned: swap pack storage to Vercel KV/Upstash then.
- Demo-app testids: `email-input`, `password-input`, `login-submit`, `login-error`,
  `buy-pack-btn`, `purchase-complete`, `owned-packs`, `pack-card`, `inventory-empty`,
  `pack-canvas` (on the real `<canvas>`), `packs-remaining`, `no-packs`, `open-error`,
  `session-email`, `logout-btn`.
- puppeteer-core + system Chrome 140+ has an input-delivery bug after redirects; use
  Playwright for any browser automation (it's the runtime anyway).

## Open questions for the founder

- None blocking. Phase 1 starts when the GitHub repo + Vercel project exist
  (SETUP.md items 1–2) — GitHub App creation will be walked through step-by-step then.

## Pending SETUP.md items

1. Create GitHub repo + push (SETUP.md #1)
2. Vercel project for demo-app + env vars + manual chaos-flag check on prod URL (SETUP.md #2)
3. Stripe test keys (optional until Phase 11) (SETUP.md #3)

## Next session

- If SETUP.md #1–2 done → verify demo-app on Vercel (final Phase 0 AC), then begin
  **Phase 1 — Webhook plumbing** (doc 09): Fastify api app, GitHub App webhooks,
  `packages/vercel`, sticky comment "hello" path.
