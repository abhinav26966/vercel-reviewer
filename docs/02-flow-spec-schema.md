# 02 — Flow Spec Schema (THE central contract)

Two formats exist. The **Recording Trace** is what the Chrome extension emits (raw, verbose, lossless). The **Flow Spec** is what the compiler produces and the runner consumes (curated, deterministic, versioned). Both live in `packages/schemas` as Zod schemas; this doc is their source of truth.

## 1. Recording Trace (extension output)

```jsonc
{
  "traceVersion": 1,
  "recordedAt": "2026-07-05T10:00:00Z",
  "origin": "https://staging.packgame.com",        // recording origin
  "viewport": { "width": 1280, "height": 720, "dpr": 1 },
  "userAgent": "...",
  "events": [
    {
      "id": "evt_0001",
      "ts": 1520,                                   // ms from recording start
      "type": "click",                              // click | dblclick | input | keypress | scroll | navigation | select | hover(optional)
      "url": "https://staging.packgame.com/shop",
      "target": {
        "tag": "button",
        "locators": [                               // captured in priority order
          { "kind": "testid", "value": "buy-pack-btn" },
          { "kind": "role", "value": { "role": "button", "name": "Buy Pack" } },
          { "kind": "text", "value": "Buy Pack" },
          { "kind": "css", "value": "#shop > div.grid > button:nth-child(2)" }
        ],
        "a11y": { "role": "button", "name": "Buy Pack", "path": ["main","region[name=Shop]","button[name=Buy Pack]"] },
        "boundingBox": { "x": 412, "y": 300, "w": 120, "h": 44 },
        "isCanvas": false,
        "canvasRelative": null                      // when isCanvas: {nx:0.41,ny:0.55} normalized to canvas box
      },
      "value": null,                                 // for input events: the typed value; REDACTED if field type=password or matched secret patterns → "«redacted:password»"
      "screenshotBefore": "shots/evt_0001_before.png",  // keys into the uploaded artifact bundle
      "screenshotAfter": "shots/evt_0001_after.png",
      "domSnapshotAfter": "dom/evt_0001.json",       // trimmed a11y-tree snapshot, not full HTML
      "network": [                                   // requests that started between this event and the next
        { "method": "POST", "url": "/api/packs/buy", "status": 200, "ttfbMs": 84, "totalMs": 130, "resourceType": "fetch" }
      ]
    }
  ],
  "finalScreenshot": "shots/final.png",
  "consoleErrors": [ { "ts": 4100, "text": "..." } ]
}
```

Rules: password inputs and any field whose value matches a stored secret are redacted **inside the extension before upload**. Screenshots of password fields are fine (dots render); the trace never contains the plaintext.

Nullability clarifications (schema implementation): `target` is `null` for pure navigation events (no interacted element); `target.a11y` and `target.boundingBox` may be `null` when no AX node / box exists (e.g. canvas internals); `screenshotBefore/After` and `domSnapshotAfter` are `null` when the throttled capturer skipped the event; navigation events may carry `newTab: true` (doc 03 A3). The trace also carries `assertionMarkers: number[]` — timestamps where the user pressed "mark assertion here" (doc 03 A2).

## 2. Flow Spec (compiler output, runner input)

```jsonc
{
  "specVersion": 3,                 // schema version of this document format
  "flowId": "flw_9f2c",
  "projectId": "prj_a1",
  "name": "Buy & Rip Open a Pack",
  "description": "From shop, purchase a pack with Stripe test card, then open it and verify 5 cards revealed.",
  "tier": "standard",               // "smoke" (always runs) | "standard"
  "persona": "premium_user",        // key into credential resolution (doc 07); null = unauthenticated flow
  "startPath": "/shop",             // appended to the deployment base URL
  "viewport": { "width": 1280, "height": 720, "dpr": 1 },
  "env": { "requiresWebGL": true },
  "budgets": {
    "flowTotalMs": { "soft": 15000, "hard": null },   // hard=null → perf issues are warnings only (default)
    "perStepDefaults": { "relativeFactor": 3.0, "absoluteFloorMs": 500 }  // dual-threshold gate vs baseline
  },
  "steps": [
    {
      "id": "s1",
      "title": "Click Buy Pack",
      "intent": "Purchase one pack from the shop grid",
      "action": {
        "type": "click",            // click|type|press|select|scroll|navigate|waitFor|canvasClick|payment|custom
        "locators": [               // tried in order; ≥2 required for DOM actions (compiler enforces)
          { "kind": "testid", "value": "buy-pack-btn" },
          { "kind": "role", "value": { "role": "button", "name": "Buy Pack" } },
          { "kind": "text", "value": "Buy Pack" }
        ]
      },
      "settle": { "strategy": "networkidle+animation", "timeoutMs": 10000 },
      "postConditions": [           // ALL must hold after settle
        { "kind": "dom", "assert": "visible", "locators": [ { "kind": "testid", "value": "stripe-checkout" } ],
          "description": "Stripe checkout appears" }
      ],
      "timingBaselineKey": "s1"     // joins to perf baselines
    },
    {
      "id": "s2",
      "title": "Pay with test card",
      "action": {
        "type": "payment",
        "provider": "stripe",           // stripe | paypal_sandbox | razorpay_test | custom
        "variant": "card",              // card | card_3ds
        "configRef": "project"          // resolves to payment config bundle (doc 07); PR-scope may override
      },
      "settle": { "strategy": "navigation", "timeoutMs": 20000 },
      "postConditions": [
        { "kind": "url", "assert": "pathMatches", "value": "/shop/success" },
        { "kind": "dom", "assert": "visible", "locators": [{ "kind": "text", "value": "Purchase complete" }] }
      ],
      "caveats": ["webhook_dependent"]   // enables the “purchase ok but state didn’t update → likely preview webhook not configured” attribution (doc 05)
    },
    {
      "id": "s3",
      "title": "Open inventory and verify pack count increased",
      "action": { "type": "navigate", "path": "/inventory" },
      "settle": { "strategy": "networkidle", "timeoutMs": 8000 },
      "postConditions": [
        { "kind": "delta", "metric": "packCount",
          "read": { "kind": "dom-count", "locators": [{ "kind": "testid", "value": "pack-card" }] },
          "assert": "increasedBy", "value": 1,
          "description": "Pack count is +1 vs start of flow (delta assertion — shared test account accumulates state)" }
      ]
    },
    {
      "id": "s4",
      "title": "Rip open the pack",
      "action": {
        "type": "canvasClick",
        "canvasLocator": [ { "kind": "testid", "value": "pack-canvas" }, { "kind": "css", "value": "canvas" } ],
        "point": { "nx": 0.50, "ny": 0.62 },        // normalized coords from recording; valid at spec viewport
        "visionFallback": { "describe": "the unopened glowing card pack in the center of the 3D scene" }
      },
      "settle": { "strategy": "animationQuiescence", "timeoutMs": 15000,
                  "quiescence": { "sampleEveryMs": 500, "stableFrames": 3, "diffThresholdPct": 1.5 } },
      "postConditions": [
        { "kind": "state", "read": "window.__flowState.cardsRevealed", "assert": "equals", "value": 5,
          "optional": true, "description": "Preferred: state SDK if the app exposes it" },
        { "kind": "vision", "question": "How many trading cards are face-up and fully revealed on screen? Answer with an integer.",
          "assert": "equals", "value": 5,
          "description": "Fallback: semantic visual assertion at settle point" }
      ]
    }
  ],
  "coverage": {                      // written back after runs; consumed by diff-aware selection (doc 06)
    "files": ["app/shop/page.tsx", "components/PackCanvas.tsx", "app/api/packs/buy/route.ts"],
    "apiRoutes": ["POST /api/packs/buy", "GET /api/inventory"],
    "collectedAtSha": "abc123",
    "collectedAt": "2026-07-05T10:20:00Z"
  }
}
```

## 3. Field semantics and invariants

**Locator stacks.** Every DOM action carries ≥2 locators in priority order: `testid` > `role` > `text/label/placeholder` > `css` (last resort). Runner tries each with a short per-locator timeout before declaring a locator miss. `xpath` is forbidden. Compiler fails compilation if it cannot produce ≥2 for a step and flags the step for the user ("add a data-testid here for reliability").

**Assertion kinds.**
- `dom`: `visible | hidden | enabled | textMatches | countEquals | attrEquals` against a locator stack.
- `url`: `pathMatches | equals` (regex allowed for pathMatches).
- `delta`: reads a numeric metric at flow start and re-reads now; asserts `increasedBy | decreasedBy | changedBy | unchanged`. **Default style for anything touching persistent data** because v1 uses a shared test account whose state accumulates across runs. Reads: `dom-count`, `dom-number` (parse number from text), `state` (window path).
- `state`: reads a `window.__flowState.*` path via `page.evaluate` (the optional SDK, doc 04 §6). `optional:true` means "use if present, don't fail if the hook doesn't exist" — the paired `vision` assertion is the fallback.
- `vision`: a question posed to the vision model against the settle-point screenshot with a structured expected answer (`equals | contains | yesno`). Only kind allowed to consult a model at runtime, and only at settle points.
- `network`: `requestSucceeded` (method+url pattern, status class) — used sparingly; primarily diagnostic data is collected regardless.
- `console`: `noNewErrorsMatching` (regex) — off by default.

**Settle strategies.** `networkidle`, `navigation`, `networkidle+animation` (network idle AND no rAF-driven layout change for 500ms), `animationQuiescence` (screenshot sampling until N consecutive frames differ < threshold — the canvas workhorse), `timeout` (fixed; discouraged). Settle marks where timing stops and assertions/screenshots happen.

**Budgets & timing.** Per-step measured duration = action dispatch → settle. Compared against the perf baseline (doc 05 §4) with the dual threshold: flag only if `head > base × relativeFactor` AND `head − base > absoluteFloorMs`. Flow-level `soft` budget → 🟡 warning; `hard` (user opt-in) → failure.

**Payment steps.** `type:"payment"` is a typed step, not recorded clicks: the runner natively knows each provider's frame structure (Playwright frameLocators, allowlisted provider domains) and fills from the resolved payment config. Execution is gated by the live-mode guard (doc 07 §5) — if test mode cannot be positively confirmed, the step fails closed with verdict `payment_unverified_env`, never proceeds.

**Canvas steps.** `canvasClick` resolves the canvas element via `canvasLocator`, converts `point` (normalized) to absolute page coordinates at the spec viewport, clicks. On assertion failure OR when `point` is null, `visionFallback.describe` is sent to the grounding model with the current screenshot → coordinates → click. Grounding results with confidence < threshold → step fails as `grounding_failed` (better honest fail than random click).

## 4. Versioning & baseline linkage

A Flow Spec row is immutable once created. `flows` table points at a `current_version` per base branch. Version statuses (doc 05, doc 08):

- `official` — the trusted baseline for a branch.
- `pending` — produced by an approved "changed-as-intended" verdict on a PR; awaiting the post-merge base run.
- `quarantined` — flow is red on the base branch itself; PR runs report "already broken on base" instead of failing PRs.
- `draft` — freshly compiled from a recording, not yet validated by a green run.

The post-merge base run (doc 05 §5) is the only path from `pending` → `official`, and also refreshes `coverage` and perf baselines. A `draft` becomes `official` after its first green validation run against the base branch.

## 5. RunFlowResult (runner output, summarized)

```jsonc
{
  "runId": "run_x", "flowId": "flw_9f2c", "specVersionId": "fsv_12", "target": "head",   // head | base
  "status": "failed",         // passed | failed | hung | dead | error(env) | skipped
  "failedStepId": "s4",
  "failureClass": "assertion", // locator_miss | assertion | hung_postcondition | crash | blank_screen | payment_unverified_env | grounding_failed | login_failed | env
  "healAttempt": { "attempted": true, "succeeded": false, "proposedPatch": null },
  "steps": [ { "id": "s1", "durationMs": 640, "settleMs": 210, "network": [...], "screenshot": "…", "assertions": [ {"kind":"dom","pass":true} ] } ],
  "perf": { "flowTotalMs": 9400, "regressions": [ { "stepId": "s2", "baseMs": 210, "headMs": 1900, "attribution": { "kind": "network", "request": "POST /api/packs/buy", "baseTtfb": 84, "headTtfb": 1720 } } ] },
  "artifacts": { "video": "s3://…", "trace": "s3://…", "har": "s3://…", "console": "s3://…", "coverage": "s3://…" },
  "diagnostics": { "pendingRequestsAtTimeout": [], "consoleErrors": [], "pageCrashed": false, "nextErrorOverlay": false, "blankScreenScore": 0.02 }
}
```

`error(env)` exists so environment problems (deployment 404, bypass rejected, login upstream down) are never reported as flow failures.
