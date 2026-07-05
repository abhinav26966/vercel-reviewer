# 07 — Credentials, Sessions & Payments

## 1. v1 model (locked)

Plain **username/email + password** per persona. No auth-provider integrations in v1 (Supabase admin API / Clerk / Auth0 are v2 — but design the resolution layer as a pluggable `AuthStrategy` interface with exactly one v1 implementation: `password_login`, so v2 plugins slot in without refactor).

Personas: named credential sets per project (`default`, optionally `admin`, `premium_user`…). Flow specs reference a persona name, never raw credentials.

## 2. Consequence of a shared test account: delta assertions

State accumulates across runs (every run buys another pack). Therefore: compiler rewrites absolute data assertions to **delta form** ("pack count increased by 1", not "user has exactly 1 pack"); flows should be authored to be re-runnable against dirty state; parallel flow jobs that mutate the same account's overlapping state should be marked (`serialGroup` field, optional) so the planner serializes them. (Clean-slate ephemeral users arrive with v2 provider integrations.)

## 3. Scoping & resolution hierarchy (the Supabase-branch problem)

Credentials exist at two scopes: **project defaults** (entered once at setup, reused for every PR) and **PR-scoped overrides** (for PRs whose preview points at a different database — e.g. a feature PR using its own Supabase branch, where project-default users don't exist).

**Resolution is per DEPLOYMENT TARGET, not per run** — a single review run has two targets that may use different databases:

| Target | Resolution |
|---|---|
| head preview | PR-scoped credentials if present → else project defaults |
| base preview | project defaults, **always** |

Same hierarchy applies to payment config: `{login persona, payment config, dataBranchDiffers flag}` resolve together as one **config bundle per target**. `dataBranchDiffers = true` whenever head resolved from PR scope (or the user flagged it) — passed to the runner job and the judge, which then discriminates data-value vs structural divergence (doc 05 §3.4).

**Acquisition UX:** never collect credentials in PR comment threads (visible to all repo readers, emailed, permanent). If login fails on head with defaults (or no defaults exist), the bot posts: "login failed on this preview — this PR may use a separate database; provide PR-scoped credentials **[secure dashboard link scoped to this PR]**, then comment `/flowguard rerun`." PR-scoped credentials **auto-delete when the PR closes or merges** (they reference a DB branch about to be garbage-collected; expiry is free hygiene).

## 4. Secret handling (non-negotiables)

1. **Encrypted at rest:** per-secret data keys wrapped by a KMS master key (envelope encryption). Plaintext exists only in runner memory during a job.
2. **Reference-passing:** jobs carry `sec_*` references; the runner resolves at last moment.
3. **Redaction registry:** the moment a plaintext is resolved, it registers with a process-wide redactor that scrubs every logging/artifact sink: logs, RunFlowResults, HAR bodies (strip request bodies on auth/payment endpoints entirely), console captures, DOM snapshots (input values), judge evidence bundles, and **all LLM prompts**.
4. **Secrets never enter model context:** agentic heal and any prompt see `{{secret:premium_user.password}}` placeholders; the runner substitutes at keystroke time. (Leak vector + prompt-injection amplifier otherwise.)
5. **Origin scoping:** stored secrets may only be typed into the current deployment host's origin. Payment values additionally into allowlisted provider frame origins (Stripe domains etc.). Any other origin → hard refusal + env_issue. (Same principle TesterArmy applies to bypass tokens.)
6. **Extension-side redaction** of recorded password/secret-pattern inputs before upload (doc 03 A2).

## 5. Sessions: log in once, not per flow

Per (persona, deployment): execute the project's Login flow once → save Playwright `storageState` (cookies + localStorage) to S3 → inject into every subsequent flow's context. Removes the login page as a flake multiplier (one flaky login otherwise fails the whole suite) and cuts runtime. Cache invalidates per deployment (new preview build = new host = dead sessions). The Login flow itself remains a real flow (smoke tier recommended) — tested once per target, not taxed onto every flow. Login failure classification: env class `login_failed`, triggers the PR-scoped-credentials comment path, all dependent flows report 🟣 not 🔴.

## 6. Payments

**Explicit consent gate:** payment steps are **disabled until the user configures payments** for the project — even though Stripe test cards (4242 4242 4242 4242) are public knowledge. Configuring is where the user affirmatively acknowledges "this reviewer will execute checkout flows against my payment provider's test mode," picks the provider, and supplies card details + quirks (specific test card their backend expects, coupon codes). PR-scoped payment overrides supported (same hierarchy as §3) for PRs testing new price IDs/providers.

**Soft validation at config time:** entered card not in the recognized test-card sets (Stripe documented cards, provider sandbox cards) → hard warning: "this doesn't look like a known test card — if it's a real card, remove it now," + extra confirmation to save. (People paste real cards more often than you'd hope.)

**Live-mode guard — mandatory, independent of user config, fail closed:** before filling any payment form the runner must positively confirm test mode: `pk_test_` publishable key present in page context / Stripe test-mode badge in Checkout / provider sandbox indicators. Cannot confirm → step fails `payment_unverified_env` (🟣 "payment step skipped — could not verify test mode on this preview"), never proceeds. Guard exists because the danger is the *environment* (preview accidentally carrying `pk_live_` keys ⇒ real charges), not the card; user-supplied details do not relax it.

**Execution (Stripe module v1):** typed `payment` step (doc 02 §3) — the runner natively drives Stripe's Elements/Checkout via Playwright `frameLocator`s on allowlisted Stripe frame origins (recorded iframe internals are NOT needed; cross-origin iframes are opaque to the recorder anyway). `variant: card` fills number/expiry/CVC + submits; `card_3ds` (e.g. 4000 0027 6000 3155) additionally handles the test 3DS modal (click "Complete authentication" in the challenge frame). Design as `PaymentProvider` interface (`detectTestMode`, `fill`, `handleChallenge`, `frameAllowlist`) — Stripe first; PayPal sandbox / Razorpay test as future modules.

**Webhook attribution:** purchase visibly succeeded (success redirect, 2xx trail) but state post-condition failed and diff didn't touch purchase code → 🟣 with "commonly a payment webhook not configured for preview deployments" copy (doc 05 §3.5). This WILL happen constantly with buy-then-use flows; correct attribution here is a trust cornerstone.

## 7. Known walls (v1 = detect & explain, not solve)

OAuth-only login ("Sign in with Google", no password path): setup-time detection → clear error "connect a password-enabled test account or (v2) a provider integration"; automating Google's own login is fragile and ToS-hostile — never attempt. Email OTP/magic links: v2 (test inbox integration); v1 error explains. TOTP 2FA: v2 (store seed, generate codes). CAPTCHAs: never attempt to beat; instruct users to use reCAPTCHA/hCaptcha/Turnstile documented test keys on previews. Every wall must fail at **setup/validation time** with instructions, not as a mysterious runtime failure.
