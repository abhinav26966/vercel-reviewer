/**
 * Demo integration of the published FlowGuard state SDK (doc 04 §6).
 *
 * The SDK exposure is gated on NEXT_PUBLIC_FLOWGUARD_SDK so the Phase-12 AC can
 * flip it off (vision-only path) and on (state-read path) via an env var + a
 * redeploy — no code change. Off ⇒ window.__flowState is never set, so
 * FlowGuard's `state` assertions skip and their paired `vision` assertions
 * cover; on ⇒ assertions read exact state.
 */
import { flowState } from "@flowguard/state";

function sdkEnabled(): boolean {
  // default ON; "0" disables (the "SDK removed" AC variant)
  return process.env.NEXT_PUBLIC_FLOWGUARD_SDK !== "0";
}

export function initFlowState(): void {
  if (!sdkEnabled()) return;
  flowState.set({ packOpened: false, cardsRevealed: 0 });
}

export function setFlowState(patch: { packOpened?: boolean; cardsRevealed?: number }): void {
  if (!sdkEnabled()) return;
  flowState.set(patch);
  if (patch.packOpened) flowState.event("pack_opened");
}
