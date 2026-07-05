# 03 — Recorder Extension & Vision Compiler

## Part A: Chrome Extension Recorder

### A1. Purpose & constraints
Zero-code-change flow capture on any environment of the user's app (localhost, staging, prod, preview). Emits the Recording Trace (doc 02 §1) + screenshot bundle to the API. Manifest V3.

### A2. Architecture
- **Popup/side panel UI:** sign in (token from dashboard), pick project, name the flow, Start/Stop, live step list, "mark assertion here" button (lets the user flag a moment as important — becomes a strong hint for the compiler to mint an assertion at that step).
- **Background service worker:** owns the `chrome.debugger` (CDP) session on the recorded tab. CDP is the backbone — content scripts alone cannot see cross-origin iframe internals, capture screenshots reliably, or get the a11y tree.
- **CDP domains used:** `Runtime` + injected binding for event capture, `Page.captureScreenshot` (before/after each event, throttled), `Accessibility.getPartialAXTree` for the target node, `Network.enable` for request capture windowed between events, `Page.frameNavigated` for navigation events.
- **Content script (isolated world):** event listeners (capture phase) for click/dblclick/input(debounced per field)/keydown(Enter,Escape,Tab)/change/scroll(debounced)/submit. For each event: compute the locator stack (testid → role+accessible name via a bundled a11y-name lib → text/label/placeholder → short unique CSS), bounding box, `isCanvas` (target is `<canvas>` or inside a canvas-owning wrapper) and normalized canvas coords, then post to the service worker which enriches with CDP data.
- **Redaction at source:** `input[type=password]` values → `«redacted:password»`. A configurable denylist of field name patterns (`card`, `cvc`, `ssn`, `secret`, `token`) also redacts. This happens **in the extension**, before anything leaves the browser.
- **Upload:** on Stop, zip trace JSON + screenshots + trimmed DOM/a11y snapshots → `POST /api/recordings` (multipart, resumable for large bundles). Server stores raw bundle in S3 and enqueues a `compile` job.

### A3. Practical notes
- Recording ignores our own extension UI events.
- Multi-tab: v1 records a single tab; a navigation that opens a new tab is captured as a `navigation` event with `newTab:true` and the recorder follows it (re-attach debugger). Stripe-hosted checkout redirects stay in-tab and are captured normally; **cross-origin iframe internals (Stripe Elements) are intentionally NOT captured click-by-click** — the compiler detects payment context (see B4) and emits a typed `payment` step instead.
- Also accept **Chrome DevTools Recorder JSON exports** as an alternate input (`POST /api/recordings/import-devtools`): map their step schema into a Recording Trace (no screenshots → compiler runs in degraded mode and asks the user to confirm assertions manually). Cheap to build, great for day-one adoption.

## Part B: Compiler (Recording Trace → Flow Spec)

### B1. Principle
The **DOM/event trace is ground truth for WHAT happened**; the **vision model supplies the semantic layer**: step titles, intent, flow description, and — the critical part — **post-condition assertions**. A recording proves what the app did once; assertions define what it *should* do every time. Compilation runs once per flow (authoring / re-baseline), so use a strong hosted multimodal model here; cost is a rounding error.

### B2. Pipeline stages
1. **Normalize & segment.** Merge input keystrokes per field; collapse scroll noise; split on navigations; drop dead events (clicks with no DOM/network/visual consequence — compare before/after screenshots + DOM snapshots).
2. **Locator hardening.** For each step, validate captured locators against the stored DOM snapshot (unique? stable-looking?). Score and order them. If <2 solid locators: mark step `needsAttention` with the suggestion "add data-testid".
3. **Vision pass (per step batch).** Send: before/after screenshots, event descriptor, network summary, a11y target info. Prompt asks for structured JSON: `{ title, intent, suggestedPostConditions[], isLoginStep, isPaymentContext, settleStrategySuggestion }`. Post-conditions must reference concrete evidence: elements visible in the after-shot (with best-guess locator from the DOM snapshot), URL changes, count changes ("5 cards appeared → suggest vision assertion 'count face-up cards == 5' since target is canvas").
4. **Flow-level vision pass.** First/last screenshots + step titles → flow `name` (if user left blank), `description`, and end-state assertions.
5. **Special-step detection.**
   - **Login detection:** password-typed field + auth-looking POST → replace the concrete typed steps with a `persona` reference: the flow's `persona` field is set, the explicit login steps are REMOVED from the spec (runner injects session via storageState per doc 07), and a separate dedicated "Login" flow is offered to the user if they don't have one ("we noticed this recording logs in — keep Login as its own smoke flow?").
   - **Payment detection:** navigation to known provider domains / provider iframes / provider JS globals in the DOM snapshot → replace the click-sequence with a typed `payment` step (`provider`, `variant: card|card_3ds` inferred; `configRef:"project"`). Warn user if no payment config exists yet.
   - **Canvas steps:** `isCanvas` events → `canvasClick` with normalized point; vision pass writes `visionFallback.describe` from the before-screenshot ("the unopened glowing pack…").
6. **Delta rewriting.** Any suggested assertion of the form "user now has N items" is rewritten to a `delta` assertion (`increasedBy`) — shared-account state accumulates across runs (doc 07 §2).
7. **Draft assembly & human review.** Emit Flow Spec with status `draft`. Dashboard shows a **compilation review screen**: step list with screenshots, editable titles, each assertion with a checkbox (accept/edit/remove), `needsAttention` flags surfaced. Founder decision: assertions are ALWAYS human-confirmed before a spec can validate — this is 2 minutes of user time that prevents weeks of false-positive pain.
8. **Validation run.** On user confirm, enqueue a validation run of the draft against the base branch deployment. Green → status `official` (becomes the baseline). Red → surfaced back with diagnostics.

### B3. Plain-language authoring (secondary path)
User writes: "Log in as premium_user, go to /shop, buy a pack with the test card, open it, expect 5 cards." Compiler prompts the strong model to draft a Flow Spec directly (no screenshots), marks every step `needsAttention`, and the validation run against base doubles as the discovery pass: the agentic executor (doc 04 §5) runs it once in exploratory mode, and successful concrete actions (locators found, coordinates used) are written back into the spec — "agent explores once, spec replays forever."

### B4. Compiler output contract
Exactly one Flow Spec (doc 02 §2), Zod-validated, plus a `compilationReport` (dropped steps, hardened locators, detected login/payment/canvas, open `needsAttention` items). Compilation never invents steps that have no corresponding trace event (hallucination guard: every spec step must reference ≥1 source event id, except typed replacements for login/payment which reference the event range they replaced).
