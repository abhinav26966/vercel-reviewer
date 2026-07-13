# Onboard your Next.js app to FlowGuard

FlowGuard reviews your **named user flows** on every PR — it opens your Vercel
preview, replays flows like "Login" or "Buy Pack", and posts a verdict naming
the exact flow that broke, with video proof. This is the ~15-minute setup.

The dashboard shows this same checklist live per project
(`GET /api/projects/:id/onboarding`) and ticks items off as you complete them.

## 1. Install the GitHub App (2 min)
Install **FlowGuard** on the repo you want reviewed. This grants read on the
code + PRs and write on checks/comments. FlowGuard posts one sticky comment per
PR — never a wall of new comments.

## 2. Connect Vercel (3 min)
FlowGuard needs to reach your preview deployments:
- Add a **Vercel access token** and your **Project ID / Team ID** (dashboard →
  project settings). Read-only usage: it lists deployments and reads their URLs.
- If your previews use **Deployment Protection**, add a **Protection Bypass for
  Automation** secret so the runner can load the preview.
- Set **Root Directory** if your app isn't at the repo root (e.g.
  `examples/demo-app`) — this maps coverage to your files for diff-aware
  selection.

## 3. Add a test account (2 min)
Most flows start logged in. Add **project-default credentials** (email +
password) for a **test account** on your app. v1 is password auth only —
OAuth-only logins are a known wall (you'll get a clear setup-time message).
Credentials are envelope-encrypted; they are typed via CDP so they never enter
traces, and never reach any model.

> If a PR's preview points at a different database (e.g. a Supabase branch), add
> **PR-scoped credentials** for it — head and base resolve independently.

## 4. Record your first flow (5 min)
Use the **Chrome recorder extension** (or describe the flow in plain language).
A vision model compiles the recording into a deterministic Flow Spec at
authoring time — at runtime it's plain Playwright, so runs are fast and
repeatable. Review the compiled steps (assertions are always human-confirmed),
then it validates against your base branch and promotes to official.

Mark 2–3 critical flows as **smoke** — they run on every PR regardless of the
diff.

## 5. Open a PR → get a verdict
Push a PR. When the preview builds, FlowGuard runs the affected flows against it,
compares to the base branch, and posts the verdict table. Every flow row names
the exact step and cause; failures carry video/trace/screenshot links.

**A verdict looks wrong?** Every comment has a **"Report it"** link. False
positives are the one thing we treat as a bug — reports feed a weekly review and
the platform false-positive metric.

## Optional upgrades
- **Payments**: configure Stripe test-mode (consent-gated) to test buy-then-use
  flows. A mandatory live-mode guard refuses to fill any form it can't confirm
  is test mode.
- **State SDK**: `npm i @flowguard/state` and expose your outcome state
  (`flowState.set({ cardsRevealed: 5 })`) — canvas/game flows then verify by
  exact state read instead of vision. Zero integration works via vision;
  one line makes it bulletproof.
- **Bring your own model**: add your own inference key in project settings so
  vision/judge quality is your cost. The platform default (free models) works
  with no key.
