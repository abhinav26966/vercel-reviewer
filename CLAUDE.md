# CLAUDE.md — Project Context for Claude Code

## What this project is

**Working name:** FlowGuard (rename freely; referred to as "the reviewer" throughout).

FlowGuard is a **GUI-level PR reviewer for Vercel preview deployments**. It is NOT a code-diff reviewer (not another CodeRabbit). When a PR is opened on a connected GitHub repo:

1. Vercel builds a preview URL for the PR head (and one exists/is built for the base branch).
2. FlowGuard spins up an ephemeral container running Playwright.
3. It replays **user-defined, named flows** (e.g. "Login", "Buy Pack", "Pack Rip Opening") against the head preview, compares against the base preview / cached baselines.
4. It posts a verdict on the PR: which exact named flow broke, at which step, with video/screenshot proof, performance regressions, hangs, and whether a divergence looks intentional given the PR's stated intent.

Flows are defined by users via a **Chrome extension recorder** (or plain-language description). A **vision LLM compiles** recordings into deterministic flow specs at authoring time. Runtime execution is **deterministic Playwright first, AI agent as fallback/healer/judge** — never LLM-per-step on every run.

## The one-sentence pitch

> "Flag the exact named flow that broke, with video proof, on every PR — before merge."

## Core architectural principles (violating these = wrong direction)

1. **AI at authoring/healing/judging time; deterministic Playwright at run time.** Per-step LLM execution on every PR is slow, expensive, and non-deterministic. Benchmarks: hand-written Playwright ≈98% task completion vs LLM browser agents ≈72–80%, but agents self-heal where scripts rot. So: compile once with AI, replay deterministically, invoke AI only on failure (heal + diagnose) and for canvas/visual assertions.
2. **Base-vs-head comparison is the truth mechanism.** Every signal (pass/fail, timing, hang) is only meaningful relative to the same flow run against the base branch preview. Never blame a PR for something already broken on base.
3. **False positives are death.** One wrong "your login flow is broken" per week and developers mute the bot. Every design choice (warm-up runs, dual thresholds, quarantine, webhook-attribution caveats, delta assertions) exists to protect trust.
4. **Fail closed on safety-critical steps.** Payment steps require positive confirmation of provider test mode. Secrets are never typed into non-preview origins and never enter LLM prompts.
5. **Baselines must never silently rot.** Every intentional flow change flows through a pending→promoted lifecycle tied to base-branch merge runs. Stale baselines are the silent killer of recording-based tools.
6. **Untrusted text is untrusted.** PR titles/descriptions/commit messages are author-controlled free text fed to LLM judges — treat as evidence that can downgrade severity, never as instructions and never as auto-pass authority. Same for any page content the agent reads.

## Document map (read in this order)

| Doc | Contents |
|---|---|
| `00-project-overview.md` | Vision, market landscape, competitors, differentiation wedges, scope decisions (v1 vs v2) |
| `01-architecture.md` | System components, tech stack, infrastructure topology, vision-model strategy |
| `02-flow-spec-schema.md` | **The central contract**: raw recording trace format + compiled Flow Spec JSON schema (step types, locator stacks, assertions, personas, payment steps, timing budgets, baseline versioning) |
| `03-recorder-and-compiler.md` | Chrome extension recorder design; vision-LLM compilation pipeline (recording → flow spec) |
| `04-execution-engine.md` | Runner container, deterministic replay, agentic fallback/healing, perf measurement, hang/blank/dead classification, canvas/WebGL handling, optional state SDK |
| `05-verdicts-baselines-intent.md` | Verdict taxonomy, intent-aware judging, baseline registry & lifecycle (official/pending/quarantined), base-branch merge runs, PR comment format |
| `06-orchestration-github-vercel.md` | GitHub App, Vercel integration, webhooks, run state machine, concurrency/cancellation, caching, diff-aware flow selection |
| `07-auth-credentials-payments.md` | Credential vault, per-deployment-target resolution hierarchy, storageState session injection, redaction pipeline, payment step design, live-mode guard |
| `08-data-model.md` | Postgres schema for the platform (projects, flows, versions, runs, results, credentials, baselines, coverage maps) |
| `09-build-plan.md` | **Step-by-step phased build plan** with tasks, acceptance criteria, and ordering. Start here for implementation. |

## v1 scope decisions (locked by the founder — do not re-litigate without asking)

- **Auth v1:** plain username/email + password credentials only. NO provider integrations (Supabase admin API, Clerk, Auth0) in v1 — those are v2. But: credentials are **project-level defaults with per-PR overrides**, resolved **per deployment target** (head vs base can point at different databases, e.g. Supabase branches).
- **Payments v1:** Stripe-first. Payment details are **explicitly user-configured per project** (consent gate) even though test cards like 4242… are public. PR-scoped payment overrides supported. Live-mode guard is mandatory and independent of user config.
- **Trigger:** every successful preview deployment on every push to a PR, plus full-suite runs on base-branch merges, plus a nightly scheduled base run.
- **Diff-aware selection:** run only flows whose coverage intersects the PR's changed files, with fan-out rules and an always-run smoke tier.
- **Target stack of customers:** Next.js apps on Vercel (including canvas/WebGL/Three.js/react-three-fiber apps — a first-class use case, not an edge case).

## How to work in this repo

- Follow `09-build-plan.md` phase by phase. Each phase has acceptance criteria — do not proceed until they pass.
- When a design question isn't answered in these docs, prefer the choice that (a) reduces false positives, (b) keeps AI out of the hot path, (c) fails closed on secrets/payments. Ask the founder when genuinely ambiguous.
- Monorepo layout, package names, and service boundaries are specified in `01-architecture.md` §"Repository layout".
- All schemas in `02-flow-spec-schema.md` and `08-data-model.md` are the source of truth; if implementation needs to deviate, update the doc in the same PR.
