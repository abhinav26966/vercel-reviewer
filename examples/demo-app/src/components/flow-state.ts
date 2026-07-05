/**
 * Inline version of the optional FlowGuard state SDK (doc 04 §6).
 * Phase 12 replaces this with the published @flowguard/state package.
 */
export interface FlowState {
  packOpened: boolean;
  cardsRevealed: number;
}

declare global {
  interface Window {
    __flowState?: FlowState;
  }
}

export function initFlowState(): void {
  window.__flowState = { packOpened: false, cardsRevealed: 0 };
}

export function setFlowState(patch: Partial<FlowState>): void {
  const prev = window.__flowState ?? { packOpened: false, cardsRevealed: 0 };
  window.__flowState = { ...prev, ...patch };
  window.dispatchEvent(new CustomEvent("flowguard", { detail: window.__flowState }));
}
