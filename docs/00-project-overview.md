# 00 — Project Overview

## 1. Problem

Code-diff reviewers (CodeRabbit et al.) read the diff and comment on code. Nobody in the PR loop verifies that the **running product still works**: that login still logs in, that the pack-opening animation still opens a pack, that checkout still charges. Teams either click through previews manually ("can someone check this branch?"), maintain brittle hand-written Playwright suites, or ship and find out in production.

Vercel already gives every PR a real, production-like preview URL. That preview is the perfect place to answer the only question that matters at merge time: **does the product actually work on this branch?**

## 2. Product

A PR-triggered reviewer that:

1. Lets users **define named flows** ("Login", "Buy Pack", "Pack Rip Opening") by recording them with a Chrome extension on any environment of their app, or describing them in plain language.
2. **Compiles** each recording, using a vision LLM + the captured DOM/event trace, into a deterministic, replayable Flow Spec with semantic assertions ("after clicking Rip, 5 cards are revealed").
3. On **every successful preview deployment of every push** to a PR: spins up ephemeral Playwright containers, replays the flows selected by diff-impact analysis against the head preview, compares against baselines from the base branch.
4. Posts a **single sticky PR comment + per-SHA status check** with a verdict per flow: passing / broken (step + cause + video) / slower (with network-level attribution) / hung-or-dead (with the offending request) / changed-as-intended (with one-click baseline approval) / skipped (untouched by this diff).
5. On **base-branch merges**, runs the full suite against the base deployment to refresh all baselines (specs, perf medians, coverage maps), promote approved pending changes, and quarantine anything broken on base so innocent PRs aren't blamed.

## 3. Market landscape (verified via web research, mid-2026)

This category exists and is crowded ("agentic QA on preview deployments"). Know the players:

| Player | Approach | Relationship to us |
|---|---|---|
| **Autonoma** | Vercel Marketplace Deployment Check. AI agents (Planner/Automator/Maintainer) derive tests **from the codebase**, run against every preview URL, self-heal. | Closest competitor. Their tests are auto-generated from code; ours are **user-defined named flows from recordings** — devs trust explicitly-defined critical flows more than inferred ones. |
| **Meticulous** | JS snippet records real user sessions; on each PR replays sessions against base AND head commits with a deterministic Chromium + automatic network mocking; compares snapshots per event. | The recording-replay archetype. Steal: base-vs-head replay, deterministic engine, new-commit-on-main baseline runs. Their weakness: requires a code snippet in the app; sessions are implicit, not named/curated flows; network mocking means backend changes aren't really tested. |
| **TesterArmy** | Orchestration layer: GitHub deployment_status events → resolve preview URL → apply Vercel bypass automatically (scoped to the deployment host) → run tests → one sticky updating PR comment. | The plumbing archetype. Steal: their exact webhook/bypass/sticky-comment mechanics. |
| **Checksum** | Generates tests from observed production traffic; self-healing; runs in CI against staging/previews. | Coverage-from-usage. Different wedge. |
| **QA Wolf** | Managed human+AI service; Playwright output; zero-flake guarantee; ~$40+/test/month. | Services business, not self-serve product. |
| **Momentic / Octomind / QA.tech / Ranger / Bug0 / TestSprite / Mabl / testRigor** | AI-native or AI-assisted test platforms. Octomind's stated position matches ours: "AI doesn't belong in test runtime" — AI authors/maintains, deterministic Playwright executes. | Validation of our core architecture. |
| **Ito** | Spins up isolated envs per PR, generates diff-targeted tests, PR comments with video + annotated screenshots. | Validation of the artifact-rich PR comment. |

**Key benchmark reality** informing architecture: hand-written Playwright ≈98% on web-task benchmarks vs LLM browser agents ≈72–80%, with per-step LLM cost of $0.01–0.05+; but Playwright scripts need selector fixes 15–25% within 30 days vs <5% for AI-driven approaches. Conclusion baked into everything: **deterministic replay for the hot path, AI for authoring, healing, judging, and canvas.**

## 4. Differentiation wedges (in priority order)

1. **Named, user-curated flows with recording-first UX.** Incumbents mostly auto-generate coverage (from code or traffic). Developers don't fully trust auto-generated tests for business-critical flows. "Record your 8 critical flows, name them, and we guarantee a verdict on each, every push" is a clearer trust contract.
2. **Canvas / WebGL / 3D flows as first-class.** Pack-opening games, Three.js/react-three-fiber apps, editors — DOM-centric incumbents handle these worst. We ship coordinate replay + vision grounding + semantic visual assertions + an optional one-line state SDK. This is the founder's own use case and a genuinely underserved niche.
3. **Intent-aware verdicts.** Not "assertion failed" but "this flow changed — likely intentional per the PR description and the files touched; approve to update the baseline." Three-way verdicts (pass / regression / changed-as-intended) make it a *reviewer*, not a test runner.
4. **Audience: vibe-coders and small teams shipping Next.js on Vercel** with zero tests, who will never write Playwright, and who are producing exactly the AI-generated-code volume that needs GUI-level verification.

## 5. Explicit scope decisions

### v1 (build this)
- GitHub + Vercel only. Next.js-first assumptions allowed (error-overlay detection, route heuristics) but nothing that breaks other frameworks.
- Chrome extension recorder + plain-language flow authoring; DevTools Recorder JSON import as a bonus.
- Plain username/password credentials: project defaults + per-PR overrides, resolved per deployment target. No auth-provider integrations.
- Stripe payments (test mode) with explicit user opt-in config; 3DS test path; live-mode guard.
- Hosted vision/LLM APIs behind a provider abstraction (self-hosted Qwen-VL et al. is v2).
- Diff-aware selection with coverage maps; smoke tier; base result caching; per-push reruns with cancellation; base-merge baseline runs; nightly scheduled run.
- Single sticky PR comment + status checks; dashboard for flows, runs, credentials, approvals.

### v2 (documented, not built)
- Auth-provider plugins (Supabase admin API ephemeral users + data seeding, Clerk testing tokens, Auth0/Firebase admin), generic `/api/test-login` strategy.
- Self-hosted vision inference (vLLM + Qwen3-VL small / GLM-4.1V-9B / UI-TARS; Moondream for cheap binary checks).
- Netlify/other preview providers; GitLab/Bitbucket.
- GPU runner tier for heavy WebGL scenes.
- Email OTP/magic-link inbox integration; TOTP seeds; multi-persona parallelism.
- Test-data requirement blocks (`data_requirements`) with provider-backed seeding.
- SOC2 posture, SSO, usage-based billing.

## 6. Success criteria for the MVP

- A real Next.js repo connected in <15 minutes: install GitHub App, connect Vercel project, record 3 flows, enter credentials, open a PR, receive a correct verdict comment.
- False-positive rate on a stable app over 50 consecutive PR pushes: **zero hard failures** that weren't real (perf warnings excluded).
- A deliberately broken flow (e.g. rip-open button no-ops) is flagged at the exact step with video within one push.
- An intentional UI change is classified "changed-as-intended" with a working approve→baseline-promotion loop across a merge.
