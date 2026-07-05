# 01 — System Architecture

## 1. Component map

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│ Chrome Extension │────▶│                  │◀────│ GitHub App          │
│ (recorder)       │     │                  │     │ (webhooks: PRs,     │
└─────────────────┘     │                  │     │ deployment_status)  │
                        │   API / Control   │     └─────────────────────┘
┌─────────────────┐     │   Plane (Node)    │     ┌─────────────────────┐
│ Dashboard        │────▶│                  │◀────│ Vercel               │
│ (Next.js)        │     │  - webhook rcvr  │     │ (deployments, bypass │
└─────────────────┘     │  - run orchestr. │     │  secrets, projects)  │
                        │  - compiler jobs │     └─────────────────────┘
                        │  - judge jobs    │
                        │  - baseline mgr  │
                        └───┬────────┬─────┘
                            │        │
              ┌─────────────▼──┐  ┌──▼──────────────────┐
              │ Postgres        │  │ Queue (BullMQ/Redis)│
              │ (08-data-model) │  └──┬──────────────────┘
              └────────────────┘     │
                        ┌────────────▼─────────────┐
                        │ Runner fleet (ephemeral   │
                        │ Docker containers):       │
                        │ Playwright + Chromium     │
                        │ deterministic replay,     │
                        │ agent fallback, perf,     │
                        │ coverage collection       │
                        └──────┬─────────┬─────────┘
                               │         │
                 ┌─────────────▼──┐   ┌──▼───────────────────┐
                 │ Artifact store  │   │ Inference service     │
                 │ (S3: videos,    │   │ (v1: hosted LLM APIs  │
                 │ traces, shots,  │   │ behind provider       │
                 │ HARs, coverage) │   │ abstraction; v2: vLLM │
                 └────────────────┘   │ + open VLM, shared)   │
                                      └──────────────────────┘
```

Six deployable units:

1. **`api`** — control plane. Receives GitHub/Vercel webhooks, exposes REST for dashboard + extension, orchestrates runs (state machine in doc 06), manages baselines, enqueues jobs, renders/updates the sticky PR comment and status checks.
2. **`runner`** — ephemeral worker image. Pulls a job (flow spec + target deployment + resolved config bundle), executes via Playwright, streams artifacts to S3, returns a structured result. Stateless; killed after the job.
3. **`compiler`** — job type (can live in api workers): raw recording trace → compiled Flow Spec via vision LLM (doc 03).
4. **`judge`** — job type: divergence evidence + PR intent + code diff → verdict (doc 05).
5. **`dashboard`** — Next.js app: project setup, flow library, run results viewer (video/timeline), credential forms, pending-baseline approvals.
6. **`extension`** — Chrome MV3 recorder (doc 03).

## 2. Tech stack (recommended; deviate only with reason)

- **Language:** TypeScript everywhere. Playwright is TS-native; one language across extension/api/runner/dashboard.
- **Monorepo:** pnpm workspaces + Turborepo.
- **API:** Node 20+, Fastify (or Hono). Zod for all schema validation — flow specs, webhook payloads, API bodies.
- **Queue:** BullMQ on Redis. Queues: `runs` (per-flow execution jobs), `compile`, `judge`, `baseline`. Use BullMQ job groups/flow for run→flows fan-out/fan-in.
- **DB:** Postgres 15+ (schema in doc 08). Drizzle ORM (or Prisma). It is fine to use hosted Postgres (Supabase/Neon) for the platform itself.
- **Artifacts:** S3-compatible (S3/R2). Store: per-step screenshots, video (webm), Playwright trace.zip, HAR/network log, console log, V8 coverage JSON, judge evidence bundles. Presigned URLs in PR comments/dashboard.
- **Runners:** Docker image `mcr.microsoft.com/playwright:vX-jammy` base. Execution substrate v1: a small pool of always-on worker VMs pulling from BullMQ (simplest); v1.5: Fly Machines / ECS Fargate / Cloud Run jobs for true per-run ephemerality. Design the runner as "one process, one job, exit" from day 1 so the substrate swap is trivial.
- **GitHub:** GitHub App (not OAuth app). Permissions: `checks:write`, `pull_requests:write`, `contents:read`, `metadata:read`, `deployments:read`. Webhooks: `pull_request`, `deployment_status`, `push`. Octokit + `@octokit/webhooks` with signature verification.
- **Vercel:** Vercel integration (marketplace-style) or per-project token v1: user pastes a Vercel access token + selects project; store project↔repo binding explicitly (one repo can map to multiple Vercel projects — never guess). Read deployments API for URL + state; store per-project **Protection Bypass for Automation** secret.
- **LLM access:** single `packages/inference` abstraction with three capability interfaces: `visionAnalyze(images, prompt, schema)`, `groundElement(image, description) → {x,y,confidence}`, `judge(evidence) → verdict`. v1 backends: hosted frontier APIs (use a strong model for compile/judge, a cheap vision model for grounding/assertions). v2 backend: self-hosted vLLM endpoint. Never call providers directly outside this package.
- **Secrets:** KMS-encrypted at rest (or libsodium sealed boxes with a KMS-wrapped master key). See doc 07 for the redaction pipeline.

## 3. Repository layout

```
/apps
  /api          # Fastify control plane + workers (compiler, judge, baseline)
  /dashboard    # Next.js
  /runner       # standalone runner process + Dockerfile
/packages
  /schemas      # Zod: FlowSpec, RecordingTrace, RunResult, Verdict, config bundles (source of truth = doc 02)
  /inference    # LLM provider abstraction
  /github       # GitHub App client, comment renderer, checks
  /vercel       # deployments client, bypass handling
  /db           # Drizzle schema + migrations (source of truth = doc 08)
  /shared       # ids, errors, logging (with redaction), utils
/extension      # Chrome MV3 recorder
/docs           # these documents
/examples/demo-app  # a small Next.js app w/ login, Stripe test checkout, and a Three.js pack-opening scene — the permanent test target
```

Build `examples/demo-app` in Phase 0. Every phase's acceptance criteria run against it. It must include: email/password login, a list page, a Stripe test-mode checkout, a react-three-fiber canvas with a clickable 3D pack that plays an opening animation and reveals cards, an artificial `?slow=1` flag that adds latency to one API route, and a `?break=flowname` flag to deliberately break flows for testing verdicts.

## 4. Runner internals (summary; full detail in doc 04)

Per job: launch Chromium (fixed viewport 1280×720 @ DPR 1 unless spec overrides; `--use-angle=swiftshader` for WebGL) → apply Vercel bypass (cookie mode: first request with `x-vercel-set-bypass-cookie: true`) → inject persona storageState (doc 07) → replay steps from the Flow Spec with the locator stack → collect per-step timing, network (HAR), console, V8 coverage → evaluate assertions at settle points → on step failure: retry deterministically once, then agentic heal attempt (bounded), then capture failure bundle → upload artifacts → emit `RunFlowResult`.

## 5. Vision/LLM usage points (and only these)

| Moment | Model class | Frequency | Notes |
|---|---|---|---|
| Compile recording → Flow Spec | strong multimodal | once per flow authored/re-baselined | sees step screenshots + DOM trace; emits names, intents, assertions |
| Element grounding fallback (incl. canvas) | cheap vision w/ coordinate output | on locator miss / canvas steps w/o stable coords | Qwen-VL-class models output click coordinates; v1 hosted |
| Visual assertion at settle points | cheap vision | canvas flows + flows with visual assertions | binary/structured answers only |
| Heal (agentic retry) | strong multimodal, bounded steps | on deterministic failure only | max N=6 actions; produces a proposed spec patch, never silently applied |
| Judge (verdict + intent) | strong multimodal | on divergence only | full evidence bundle; prompt-injection rules in doc 05 |

Cost posture v1: hosted APIs are cheaper than idle GPUs at low volume (~$0.5–1/hr for an L4/A10G vs pennies per image via API). v2 self-hosting: one shared vLLM node serving a small Qwen3-VL / GLM-4.1V-9B, called over HTTP by all runners. **Never load model weights inside runner containers** (multi-GB weights, 30s–2min cold load, GPU per runner — wrong topology).

## 6. Cross-cutting rules

- **Idempotency:** every webhook handler is idempotent keyed on delivery ID; every run keyed on `(pr, head_sha, deployment_id)`.
- **Cancellation:** a new successful deployment for a PR cancels queued+running jobs for older SHAs (BullMQ job tokens + runner-side abort signal).
- **Logging:** structured (pino), with the redaction transform from doc 07 applied globally.
- **Time:** all timings recorded in ms with monotonic clocks inside the runner; wall-clock only for metadata.
- **Feature flags:** simple DB-backed flags per project (e.g. `perf_gate_hard`, `agent_heal_enabled`, `canvas_vision_assertions`).
