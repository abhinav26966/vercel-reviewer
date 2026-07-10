import { afterEach, describe, expect, it, vi } from "vitest";
import { flowState, FLOWGUARD_EVENT } from "../src/index.js";

afterEach(() => {
  delete (window as { __flowState?: unknown }).__flowState;
  delete (window as { __flowguard_seed?: unknown }).__flowguard_seed;
});

describe("flowState SDK (doc 04 §6)", () => {
  it("set merges, exposes window.__flowState, and fires the flowguard event", () => {
    const events: unknown[] = [];
    window.addEventListener(FLOWGUARD_EVENT, (e) => events.push((e as CustomEvent).detail));
    flowState.set({ packOpened: true });
    flowState.set({ cardsRevealed: 5 });
    expect(window.__flowState).toEqual({ packOpened: true, cardsRevealed: 5 });
    expect(flowState.get()).toEqual({ packOpened: true, cardsRevealed: 5 });
    expect(events.at(-1)).toEqual({ packOpened: true, cardsRevealed: 5 });
  });

  it("event() dispatches a named milestone on the flowguard event detail", () => {
    const detail = vi.fn();
    window.addEventListener(FLOWGUARD_EVENT, (e) => detail((e as CustomEvent).detail));
    flowState.set({ cardsRevealed: 5 });
    flowState.event("pack_opened");
    expect(detail).toHaveBeenLastCalledWith(expect.objectContaining({ event: "pack_opened", cardsRevealed: 5 }));
  });

  it("subscribe fires on set and unsubscribes cleanly", () => {
    const seen: unknown[] = [];
    const off = flowState.subscribe((s) => seen.push(s));
    flowState.set({ a: 1 });
    off();
    flowState.set({ b: 2 });
    expect(seen).toEqual([{ a: 1 }]);
  });

  it("seed returns the injected RNG seed or null", () => {
    expect(flowState.seed()).toBeNull();
    window.__flowguard_seed = 42;
    expect(flowState.seed()).toBe(42);
  });
});
