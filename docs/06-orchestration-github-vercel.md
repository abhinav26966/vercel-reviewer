# 06 — Orchestration: GitHub, Vercel, Runs

## 1. Integrations & setup flow

**GitHub App** (per-org installation): permissions `checks:write, pull_requests:write, contents:read, metadata:read, deployments:read`; events `pull_request`, `deployment_status`, `push`, `installation*`. Verify webhook signatures; store `installation_id` per org for token minting.

**Vercel** (v1 pragmatic): user pastes a Vercel access token in the dashboard, we list their projects, they **explicitly bind repo → Vercel project** (one repo can back multiple Vercel projects — marketing site, app, docs — never guess; store the binding). We also read/store the project's **Protection Bypass for Automation** secret (instruct the user to generate it in Vercel → Deployment Protection). v1.5: proper Vercel Marketplace integration + Deployment Checks API so we can appear as a native check and optionally block promotion.

**Project setup checklist (dashboard-guided):** install GitHub App on repo → connect Vercel + bind project → add bypass secret → select base branch(es) → add credentials (project defaults, doc 07) → optionally payment config → record flows → mark smoke tier → done.

## 2. Trigger model

**Primary trigger: `deployment_status` with `state=success`** — never raw `push`. We want the *built preview*, not the commit; this also automatically covers Vercel rebuilds/redeploys of the same SHA. From the event: `environment` (preview vs production), `deployment.sha`, `target_url` (preview URL), repo. Filter: preview deployments belonging to the bound Vercel project (match URL/project id — multi-project repos must not cross-trigger). Map SHA → open PR(s) via the GitHub API (`listPullRequestsAssociatedWithCommit`). SHA on a configured base branch instead → base-run pipeline (doc 05 §5).

Fallback for repos where GitHub deployment events are unreliable: poll the Vercel deployments API for the head SHA with 15s interval / 10min cap after a `pull_request.synchronize` event. Build both; prefer events.

Also handled: `pull_request.opened/reopened/synchronize` (pre-create the run record in `awaiting_deployment`, so the check UI shows "waiting for preview build"), `pull_request.closed` (cancel jobs; purge PR-scoped credentials per doc 07), issue-comment command `/flowguard rerun` (re-run latest SHA — used after supplying PR-scoped credentials or fixing env).

## 3. Run state machine

```
awaiting_deployment ──deployment success──▶ planning ──▶ resolving_base ──▶ executing ──▶ judging ──▶ reporting ──▶ done
        │                                     │                                             any step
        └────────── PR closed ──────────▶ cancelled ◀──── newer SHA deployed ────────────────┘
                                                                                    └──▶ errored (env) ──▶ reporting
```

- **planning:** resolve config bundles per target (doc 07 §3); compute diff vs merge base (GitHub compare API); run **flow selection** (§4); write the plan (flows × {head, base-if-needed}).
- **resolving_base:** compute merge base; look up baseline registry + run-result cache (§5); for cache misses, locate/create a base deployment target: latest successful base-branch deployment at (or nearest ancestor of) the merge base — Vercel keeps per-commit URLs; if none suitable, trigger a redeploy of the merge-base SHA via Vercel API (fallback; usually unnecessary).
- **executing:** enqueue per-flow jobs. Order: smoke tier first, then standard; base-side jobs (cache misses) alongside head. Warm-up job precedes measured jobs per target. Concurrency per project configurable (default 3 parallel runners).
- **judging:** flows whose head vs base outcomes diverge → judge jobs (doc 05).
- **reporting:** render/update the sticky comment; set the per-SHA check with summary; persist everything.

**Concurrency & cancellation:** BullMQ group per `(project, pr)`. A new successful head deployment for the PR: mark superseded runs `cancelled`, signal abort tokens (runners abort between steps, jobs requeue-safe), start the new run. Base runs per branch: serialized queue, newest-wins cancellation.

## 4. Diff-aware flow selection (test impact analysis)

Inputs: changed-file list (+ statuses) of the PR vs merge base; each flow's `coverage` block (files + API routes) from the latest base-branch collection.

Algorithm:
1. **Fan-out short-circuit — run ALL flows** if the diff touches any of: dependency manifests/lockfiles (`package.json`, `pnpm-lock.yaml`), framework/build config (`next.config.*`, `tsconfig`, `.env*`, `vercel.json`, `middleware.*`, `tailwind.config`, global CSS, root layouts `app/layout.*`), auth-related paths (heuristic list + user-configurable globs), or **>40% of files with coverage mappings**. Rationale: shared-code fan-out invalidates the mapping; a false negative ("we skipped the flow that broke") is worse than wasted compute.
2. **Smoke tier always runs** regardless of the diff (user marks 2–3 critical flows). Also covers cold start: until a flow has ≥1 coverage collection, it is treated as always-selected.
3. **Intersection:** select flows whose coverage files intersect changed files, OR whose API routes map to changed route handlers (Next.js convention `app/api/**/route.ts`), OR (heuristic layer, pre-coverage) whose `startPath`/visited URLs fall under a changed `app/<segment>/**` route directory.
4. Everything else → ⚪ skipped, listed in the comment so skipping is visible and auditable.
5. **Selection is recomputed on every push** — a push touching only `README.md` runs only the smoke tier.

Coverage maps refresh on every full base run (doc 04 §7, 05 §5); staleness bounded by merge frequency + nightly run.

## 5. Caching (the cost model)

- **Base run-result cache:** keyed `(flow_spec_version_id, base_sha)`. The base didn't change because head got a new push → across N pushes to a PR, base flows run once. Invalidation: merge base moved (base branch advanced under the PR), or spec version changed.
- **storageState cache:** `(persona, deployment_id)` — sessions die with each new preview build (doc 07).
- **Perf baselines:** refreshed by base runs; PR perf gates read the entry at the resolved merge base (or nearest ancestor).
- **Warm-up policy:** one warm-up per (target, run) before measured jobs, discarded; measured = median of 2 (configurable 3).

## 6. Scheduler

Cron worker: nightly full base run per configured branch per project (skip if a base run already happened in the last 12h); daily purge of expired artifacts (retention configurable, default 30 days, keep failure bundles 90); hourly sweep for stuck runs (executing > 45min → error + alert).

## 7. Env-issue reporting (never blame the PR for the world)

Classified `env_issue` (🟣), with actionable copy, when: deployment URL unreachable/bypass rejected (check secret configured?); login failed on head with project defaults (→ "PR may use a separate DB branch — provide PR-scoped credentials [link], then comment `/flowguard rerun`"); payment env unverified (doc 07 §5); webhook-dependent state gap (doc 05 §3.5); base deployment could not be resolved (report which comparison was skipped, still run head with assertion-only mode — assertions don't need a base, comparisons do).
