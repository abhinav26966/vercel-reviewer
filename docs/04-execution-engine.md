# 04 — Execution Engine (Runner)

## 1. Job contract

A runner process receives one `ExecuteFlowJob` (the job also embeds the full `spec` — runners are stateless and never read the DB, per doc 01 §1):

```jsonc
{
  "runId": "run_x", "flowId": "flw_9f2c", "specVersionId": "fsv_12",
  "spec": { /* full Flow Spec, doc 02 §2 */ },
  "target": { "kind": "head", "deploymentUrl": "https://app-git-feat-x.vercel.app", "bypassSecret": "…", "sha": "def456",
              "deploymentId": "dep_123" },   // keys the storageState cache
  "configBundle": {                       // resolved by orchestrator per TARGET (doc 07 §3)
    "persona": { "name": "premium_user", "usernameRef": "sec_1", "passwordRef": "sec_2", "storageStateKey": "ss/prj_a1/premium_user/dep_123.json",
                 "loginSpec": null },     // project Login flow, executed once per (persona, deployment) in a
                                          // throwaway context with NO artifact collection when no cached session exists
    "payment": { "provider": "stripe", "cardRef": "sec_9", "expiry": "12/34", "cvcRef": "sec_10", "source": "project" },
    "secretRefs": { "default.password": "sec_2" },  // {{secret:*}} placeholder → ref map, pre-resolved per target
    "dataBranchDiffers": true             // head uses a different DB than base → passed to judge
  },
  "mode": "measure",                      // warmup | measure | validate | explore
  "collect": { "coverage": true, "har": true, "video": true },
  "agentHeal": false,                     // bounded heal on step failure (§5); head targets only
  "abortToken": "…"
}
```

Secrets arrive as **references**; the runner resolves them from the vault at the last moment and registers each plaintext with the redaction registry (doc 07 §4) before any logging can occur.

## 2. Browser setup

- Chromium from the Playwright image. New context per job. Fixed viewport from the spec (default 1280×720, DPR 1) — fixed viewport is what makes recorded canvas coordinates replayable pixel-for-pixel.
- WebGL: launch args `--use-angle=swiftshader` (software rendering). Expect slower frame rates; all animation waits use quiescence detection, never fixed sleeps. (v2: GPU runner tier + optional headed-under-Xvfb for fidelity.)
- Vercel bypass: navigate first request with headers `x-vercel-protection-bypass: <secret>` and `x-vercel-set-bypass-cookie: true` → cookie authorizes all subsequent same-site navigations. The bypass secret is host-scoped: assert every navigation stays on the deployment host or an allowlisted provider domain (payment frames); refuse otherwise.
- Session: if `persona` set, load cached storageState for `(persona, deploymentId)`; if absent, execute the project's Login flow once headlessly, save storageState to S3, proceed. Login failure → entire run's flows report `login_failed` (env class), and the orchestrator triggers the "credentials may be wrong / PR may use a separate DB branch" comment path (doc 07 §3).
- Video: `recordVideo` on context. Tracing: `context.tracing.start({screenshots:true, snapshots:true})`. HAR: `recordHar`. Console + pageerror listeners → log with redaction. Coverage: CDP `Profiler.startPreciseCoverage` when `collect.coverage`.

## 3. Deterministic replay loop

For each step:
1. **Pre:** timestamp `t0`; screenshot-before (throttled: only kept on failure or when assertions need it).
2. **Act:**
   - DOM actions: try locator stack in order (per-locator timeout ~2.5s, total step locate budget ~8s). Playwright auto-waits handle actionability.
   - `canvasClick`: resolve canvas box → absolute point from normalized coords → `page.mouse.click`. If `point` null or a later assertion fails and retry policy allows: **vision grounding** — screenshot + `visionFallback.describe` → `groundElement()` → click returned coords if confidence ≥ 0.6, else fail `grounding_failed`.
   - `payment`: run the provider module (doc 07 §5): live-mode guard → frameLocator fills → 3DS modal handling for `card_3ds`.
   - `type`: values may contain `{{secret:*}}` placeholders → substituted at keystroke time via CDP `Input.insertText` (invisible to Playwright tracing, so the plaintext never enters trace.zip); never materialized in any string that gets logged. Tracing is additionally disabled for specs containing secret placeholders (trace network capture could otherwise embed request bodies).
3. **Settle:** per spec strategy. `animationQuiescence` = capture JPEG frames every `sampleEveryMs`, compare consecutive downscaled grayscale frames (pixelmatch), settled when `stableFrames` consecutive diffs < `diffThresholdPct`; timeout → proceed to post-condition evaluation anyway (the hang classifier decides).
4. **Assert:** evaluate `postConditions`. `state` reads via `page.evaluate`; `optional:true` state assertions that find no hook are skipped (paired vision assertion covers). `vision` assertions: settle screenshot + question → structured answer → compare.
5. **Record:** `durationMs = settle_end − t0`, settle time, network entries in window, assertion results, screenshot-after.

**Failure policy per step:** first failure → one deterministic retry of the step (re-resolve locators; page may have been mid-hydration). Second failure → heal attempt if enabled (§5). Still failing → capture failure bundle (screenshot, DOM snapshot, pending requests, console tail, video mark) and stop the flow (subsequent steps `skipped`).

## 4. Performance measurement & the slow/hung/dead spectrum

These three are one mechanism at different thresholds. Signals collected regardless of outcome: per-step duration, per-request TTFB/total from HAR, long-task entries, web vitals on initial load.

**Slow (🟡):** post-conditions eventually pass but a step exceeds the dual threshold vs baseline: `head > base × relativeFactor` AND `head − base > absoluteFloorMs` (defaults 3.0× and 500ms). Protocol that makes timing trustworthy on Vercel previews (serverless cold starts + cold caches are the #1 flake source):
- **Warm-up run first** against each target, timings discarded.
- **Median of 2–3 measured runs** (project-configurable; default 2 for cost).
- Base and head measured the **same way in the same session window**; head compared to freshly-measured or recently-cached base medians (doc 06 §5).
- **Attribution required before flagging:** diff the step's network waterfall base-vs-head. If a matching request's server time exploded → `attribution: network {request, baseTtfb, headTtfb}`. If network unchanged but duration grew → `attribution: client {longTasks, settleDelta}`. An attributed regression is a report; an unattributed small delta is suppressed.
- Severity: warning by default; failure only if the user set a `hard` budget on the flow.

**Hung (🟠):** a post-condition never becomes true within `settle.timeoutMs` + assertion grace. Sub-diagnosis from live signals: requests still pending at timeout (list them — "POST /api/packs/open pending 30s"), or a request that returned 4xx/5xx followed by a spinner that never unmounted (heuristic: element with role progressbar / common spinner classes persisting). Report: "stuck at step s4: /api/packs/open returned 500; loading indicator never resolved."

**Dead (🟠):** page crash event, uncaught pageerror, `net::ERR_*` on main frame, **Next.js error overlay present** (detect `nextjs-portal` / `#__next-build-error` etc. in DOM — cheap, high-signal for our stack), or **blank-screen score**: settle screenshot downscaled → fraction of near-uniform pixels > 0.98 → blank; vision confirm ("is this a blank/error page?") before asserting.

**The honesty rule:** every slow/hung/dead classification on head is cross-checked against the base run of the same flow. Base also hung → verdict is `already_broken_on_base` / environmental, never "your PR broke it."

## 5. Agentic heal (bounded, never in the hot path)

Trigger: deterministic replay + one retry failed on a step, `agent_heal_enabled` for the project. Loop (max 6 actions, 90s wall budget): strong multimodal model gets the flow intent, failed step intent, current screenshot + trimmed a11y tree, and may emit one action per turn (`click locator/coords`, `type`, `scroll`, `waitFor`) executed by the runner. Success = the step's post-conditions pass.
- Heal success → flow continues, result carries `healAttempt.succeeded=true` **and a proposed spec patch** (e.g. new locator that worked). The patch is NEVER auto-applied; it surfaces in the dashboard as "spec drift detected — accept updated locator?". PR verdict for a healed step: 🔵-adjacent note ("step succeeded via adaptive retry — selector likely changed"), not a hard failure.
- Heal failure → original failure stands; the heal transcript is attached to the judge's evidence bundle (it's excellent diagnosis material: "agent could not find any element resembling the Rip button").
- Injection guard: page text seen by the heal agent is data, not instructions; the agent's system prompt states this explicitly, its action space is the closed set above, and it inherits the origin allowlist + secret-placeholder rules.

## 6. Optional State SDK (canvas/game superpower)

A ~1KB snippet users can add for deterministic assertions on canvas apps:

```ts
// @flowguard/state — usage in the app
import { flowState } from "@flowguard/state";
flowState.set({ packOpened: false, cardsRevealed: 0 });
// on animation complete:
flowState.set({ packOpened: true, cardsRevealed: 5 });
flowState.event("pack_opened");            // also dispatches CustomEvent("flowguard", {detail})
```

Exposes `window.__flowState` (get/set/subscribe) + custom events. Runner reads via `state` assertions and can `waitFor` events as a settle strategy (`settle: {strategy:"flowEvent", event:"pack_opened"}`). Also recommend (docs, not enforcement): seed RNG when `window.__flowguard_seed` is present so pack contents are reproducible. Two-tier story: **works with zero integration via vision; becomes bulletproof with one line of code.**

## 7. Coverage collection (feeds diff-aware selection)

When `collect.coverage`: CDP precise coverage over the whole flow → executed script URLs+ranges → source-map resolution (fetch `.map` from the deployment; Vercel previews usually serve them — if absent, fall back to route-level heuristics) → repo-relative file set. Merge with the network-derived API route set. Write back as the flow's coverage row keyed to the SHA. Refresh on every base-branch full run (doc 05 §5).

Implementation notes (Phase 8): attribution is **chunk-level** — any executed function attributes all of the chunk's sources (over-approximating over-selects flows, which is safe; a false negative skips the flow that broke). Source paths are app-root-relative as emitted by webpack; the orchestrator prefixes the project's `rootDir` when writing `coverage_maps`, so stored files intersect the GitHub diff directly. API routes are stored as URL paths (`/api/packs/buy`); the selection layer maps changed `app/api/**/route.*` files to URL paths by the Next.js convention — the runner never needs to know whether the app uses `src/app` or `app`.
