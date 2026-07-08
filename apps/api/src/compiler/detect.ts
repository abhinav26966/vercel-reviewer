import type { TraceEvent } from "@flowguard/schemas";
import type { NormalizedEvent } from "./normalize.js";

/**
 * Stage 5 — special-step detection (doc 03 B2.5). Login and payment detection
 * are CODE, not model output: the trace carries the hard signals (redacted
 * password values, provider domains).
 */

export interface LoginDetection {
  /** event ids replaced by the persona reference */
  replacedEventIds: string[];
  persona: string;
  /** index in the normalized list AFTER which the real flow starts */
  resumeIndex: number;
}

const AUTH_URL = /login|signin|sign-in|auth|session/i;
const PAYMENT_HOSTS = /checkout\.stripe\.com|js\.stripe\.com|paypal\.com|razorpay\.com/i;

export function detectLogin(events: NormalizedEvent[]): LoginDetection | null {
  const pwIndex = events.findIndex(
    (e) => e.event.type === "input" && e.event.value?.startsWith("«redacted:password»"),
  );
  if (pwIndex === -1) return null;

  const loginPageUrl = events[pwIndex]!.event.url;
  // the login range: every event on the login page up to (and including) the
  // submit interaction, plus the navigation it caused
  let end = pwIndex;
  for (let i = pwIndex + 1; i < events.length; i++) {
    const e = events[i]!;
    if (e.event.type !== "navigation" && e.event.url === loginPageUrl) {
      end = i;
    } else if (e.event.type === "navigation" && e.consequenceOf) {
      end = i;
      break;
    } else {
      break;
    }
  }
  let start = pwIndex;
  while (start > 0 && events[start - 1]!.event.url === loginPageUrl && events[start - 1]!.event.type !== "navigation") {
    start--;
  }

  return {
    replacedEventIds: events.slice(start, end + 1).map((e) => e.event.id),
    persona: "default", // v1: single default persona; picker arrives with multi-persona UX
    resumeIndex: end + 1,
  };
}

export function looksLikeAuthPost(event: TraceEvent): boolean {
  return event.network.some((n) => n.method === "POST" && AUTH_URL.test(n.url));
}

export function detectPaymentContext(events: NormalizedEvent[]): string[] {
  return events
    .filter((e) => PAYMENT_HOSTS.test(e.event.url) || e.event.network.some((n) => PAYMENT_HOSTS.test(n.url)))
    .map((e) => e.event.id);
}
