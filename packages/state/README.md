# @flowguard/state

The optional one-line state SDK for [FlowGuard](https://github.com/flowguard) — a GUI-level PR reviewer for Vercel preview deployments.

FlowGuard replays your named user flows on every PR and verifies outcomes. For canvas / WebGL / game UIs it can do this **with zero integration** using vision ("do 5 cards show?"). This SDK is the one-line upgrade to make those checks **deterministic and exact**: expose your outcome state and FlowGuard reads it directly.

```ts
import { flowState } from "@flowguard/state";

// after the pack-opening animation resolves:
flowState.set({ packOpened: true, cardsRevealed: 5 });
flowState.event("pack_opened"); // lets a flow settle on this milestone
```

FlowGuard then asserts against `window.__flowState` (e.g. `cardsRevealed === 5`) instead of asking a model. Assertions that reference state you haven't exposed fall back to vision automatically — integration is incremental.

### Reproducible content

When a flow runs under FlowGuard, `window.__flowguard_seed` is present. Seed your RNG with it so pack contents (or any randomized UI) are reproducible across the base-vs-head comparison:

```ts
const seed = flowState.seed();
if (seed !== null) myRng.seed(seed);
```

Two-tier by design: **works with zero integration via vision; becomes bulletproof with one line of code.**
