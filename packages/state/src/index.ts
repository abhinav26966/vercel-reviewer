/**
 * @flowguard/state — the optional one-line state SDK (doc 04 §6).
 *
 * FlowGuard replays GUI flows and, by default, verifies canvas/game outcomes
 * via vision. That works with ZERO integration. This SDK is the "one line of
 * code" upgrade: expose your app's outcome state on `window.__flowState` and
 * flow assertions read it DIRECTLY (deterministic, fast, exact) instead of
 * asking a vision model "how many cards are showing?".
 *
 *   import { flowState } from "@flowguard/state";
 *   flowState.set({ packOpened: true, cardsRevealed: 5 });
 *   flowState.event("pack_opened");   // settle strategy: flowEvent
 *
 * The global shape and the "flowguard" CustomEvent are the runtime contract the
 * FlowGuard runner reads (state assertions, flowEvent settle). Publishing this
 * as a real package means customers `npm i @flowguard/state` rather than
 * copy-pasting a snippet.
 */

export const FLOWGUARD_EVENT = "flowguard";
export const FLOW_STATE_KEY = "__flowState";
export const FLOW_SEED_KEY = "__flowguard_seed";

export type FlowStateValue = Record<string, unknown>;

declare global {
  interface Window {
    __flowState?: FlowStateValue;
    /** Present under FlowGuard → seed your RNG for reproducible content (doc 04 §6). */
    __flowguard_seed?: number;
  }
}

type Listener = (state: FlowStateValue) => void;

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

class FlowStateController {
  private listeners = new Set<Listener>();

  /** Read the current state (empty object before first set). */
  get(): FlowStateValue {
    if (!hasWindow()) return {};
    return window.__flowState ?? {};
  }

  /** Merge a patch, publish a "flowguard" CustomEvent, notify subscribers. */
  set(patch: FlowStateValue): void {
    if (!hasWindow()) return;
    const next = { ...(window.__flowState ?? {}), ...patch };
    window.__flowState = next;
    for (const l of this.listeners) l(next);
    try {
      window.dispatchEvent(new CustomEvent(FLOWGUARD_EVENT, { detail: next }));
    } catch {
      // non-DOM environments (SSR) — the state read still works
    }
  }

  /**
   * Fire a named milestone event the runner can settle on
   * (`settle: {strategy:"flowEvent", event:"pack_opened"}`). The name rides on
   * the "flowguard" CustomEvent's detail.event so a single listener suffices.
   */
  event(name: string, extra: FlowStateValue = {}): void {
    if (!hasWindow()) return;
    const detail = { ...(window.__flowState ?? {}), ...extra, event: name };
    try {
      window.dispatchEvent(new CustomEvent(FLOWGUARD_EVENT, { detail }));
    } catch {
      /* ignore */
    }
  }

  /** Subscribe to state changes; returns an unsubscribe fn. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Deterministic RNG seed when running under FlowGuard, else null. */
  seed(): number | null {
    if (!hasWindow()) return null;
    return window.__flowguard_seed ?? null;
  }
}

export const flowState = new FlowStateController();
