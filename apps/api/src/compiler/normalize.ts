import type { RecordingTrace, TraceEvent } from "@flowguard/schemas";

/**
 * Stage 1 — normalize & segment (doc 03 B2.1): merge per-field keystrokes,
 * collapse scroll noise, dedupe double-fired events, and classify navigations
 * as either consequences of the previous interaction or explicit jumps.
 */

export interface NormalizedEvent {
  event: TraceEvent;
  /** navigation that happened as a RESULT of the previous interaction */
  consequenceOf?: string;
}

export interface NormalizeResult {
  events: NormalizedEvent[];
  dropped: Array<{ id: string; reason: string }>;
  /** where the flow starts once login (if any) is stripped — set later */
  firstUrl: string | null;
}

const NAV_CONSEQUENCE_WINDOW_MS = 3000;

export function normalizeTrace(trace: RecordingTrace): NormalizeResult {
  const dropped: Array<{ id: string; reason: string }> = [];
  const kept: TraceEvent[] = [];

  for (const ev of trace.events) {
    // scroll noise — never useful for replay (doc 03 B2.1)
    if (ev.type === "scroll") {
      dropped.push({ id: ev.id, reason: "scroll noise" });
      continue;
    }
    const prev = kept.at(-1);
    // merge consecutive inputs on the same field: keep the LAST value
    if (
      ev.type === "input" &&
      prev?.type === "input" &&
      prev.target &&
      ev.target &&
      JSON.stringify(prev.target.locators[0]) === JSON.stringify(ev.target.locators[0])
    ) {
      dropped.push({ id: prev.id, reason: "superseded by later input on the same field" });
      kept[kept.length - 1] = ev;
      continue;
    }
    // dedupe navigations to the same URL (frameNavigated + navigatedWithinDocument both fire)
    if (ev.type === "navigation" && prev?.type === "navigation" && prev.url === ev.url) {
      dropped.push({ id: ev.id, reason: "duplicate navigation event" });
      continue;
    }
    // dedupe double-fired identical clicks within 150ms
    if (
      ev.type === "click" &&
      prev?.type === "click" &&
      ev.ts - prev.ts < 150 &&
      JSON.stringify(prev.target?.locators[0]) === JSON.stringify(ev.target?.locators[0])
    ) {
      dropped.push({ id: ev.id, reason: "double-fired click" });
      continue;
    }
    kept.push(ev);
  }

  // clicks on text inputs right before typing into them are focus clicks, not actions
  const withoutFocusClicks: TraceEvent[] = [];
  for (let i = 0; i < kept.length; i++) {
    const ev = kept[i]!;
    const next = kept[i + 1];
    if (
      ev.type === "click" &&
      next?.type === "input" &&
      ev.target &&
      next.target &&
      JSON.stringify(ev.target.locators[0]) === JSON.stringify(next.target.locators[0])
    ) {
      dropped.push({ id: ev.id, reason: "focus click merged into the following input" });
      continue;
    }
    withoutFocusClicks.push(ev);
  }

  // classify navigations
  const events: NormalizedEvent[] = [];
  for (let i = 0; i < withoutFocusClicks.length; i++) {
    const ev = withoutFocusClicks[i]!;
    if (ev.type !== "navigation") {
      events.push({ event: ev });
      continue;
    }
    let prevIndex = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (withoutFocusClicks[j]!.type !== "navigation") {
        prevIndex = j;
        break;
      }
    }
    const prevInteraction = prevIndex >= 0 ? withoutFocusClicks[prevIndex] : undefined;
    // only the FIRST navigation after an interaction is its consequence — any
    // navigation in between means this one was an independent jump
    const navBetween = withoutFocusClicks
      .slice(prevIndex + 1, i)
      .some((e) => e.type === "navigation");
    if (
      prevInteraction &&
      !navBetween &&
      ["click", "keypress", "select", "dblclick"].includes(prevInteraction.type) &&
      ev.ts - prevInteraction.ts <= NAV_CONSEQUENCE_WINDOW_MS
    ) {
      events.push({ event: ev, consequenceOf: prevInteraction.id });
    } else {
      events.push({ event: ev });
    }
  }

  return {
    events,
    dropped,
    firstUrl: trace.events[0]?.url ?? null,
  };
}
