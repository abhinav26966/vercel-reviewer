import type { z } from "zod";
import { RecordingTraceSchema, type Locator } from "@flowguard/schemas";

type RecordingTrace = z.infer<typeof RecordingTraceSchema>;

/**
 * Chrome DevTools Recorder JSON → RecordingTrace (doc 03 A3): degraded mode —
 * no screenshots, no network, synthetic timestamps; the compiler asks the user
 * to confirm assertions manually. xpath selectors are dropped (doc 02 §3).
 */
export interface DevToolsRecording {
  title?: string;
  steps: Array<{
    type: string;
    url?: string;
    selectors?: string[][];
    value?: string;
    key?: string;
    width?: number;
    height?: number;
    deviceScaleFactor?: number;
  }>;
}

const PASSWORDISH = /password|passwd|cvc|cvv|secret|token|pin/i;

export function mapSelector(selector: string): Locator | null {
  if (selector.startsWith("xpath/")) return null; // forbidden (doc 02 §3)
  if (selector.startsWith("aria/")) {
    const body = selector.slice("aria/".length);
    const roleMatch = body.match(/\[role="([^"]+)"\]$/);
    const name = roleMatch ? body.slice(0, body.length - roleMatch[0].length) : body;
    if (roleMatch) return { kind: "role", value: { role: roleMatch[1]!, name } };
    return { kind: "text", value: name };
  }
  if (selector.startsWith("text/")) return { kind: "text", value: selector.slice("text/".length) };
  if (selector.startsWith("pierce/")) return { kind: "css", value: selector.slice("pierce/".length) };
  const testidMatch = selector.match(/^\[data-testid=['"]?([^'"\]]+)['"]?\]$/);
  if (testidMatch) return { kind: "testid", value: testidMatch[1]! };
  return { kind: "css", value: selector };
}

function mapSelectors(selectors: string[][] | undefined): Locator[] {
  const locators: Locator[] = [];
  for (const group of selectors ?? []) {
    for (const s of group) {
      const mapped = mapSelector(s);
      if (mapped && !locators.some((l) => JSON.stringify(l) === JSON.stringify(mapped))) {
        locators.push(mapped);
      }
    }
  }
  return locators;
}

function tagFromSelectors(selectors: string[][] | undefined): string {
  const flat = (selectors ?? []).flat().join(" ");
  for (const tag of ["button", "input", "select", "textarea", "canvas", "a"]) {
    if (new RegExp(`(^|[ >])${tag}([.:#[]|$|\\b)`).test(flat)) return tag;
  }
  return "element";
}

export function importDevToolsRecording(recording: DevToolsRecording): RecordingTrace {
  const events: RecordingTrace["events"] = [];
  let viewport = { width: 1280, height: 720, dpr: 1 };
  let origin = "https://unknown.invalid";
  let currentUrl = origin;
  let seq = 0;

  const push = (
    type: "click" | "dblclick" | "input" | "keypress" | "navigation" | "select",
    partial: {
      url?: string;
      locators?: Locator[];
      tag?: string;
      value?: string | null;
    },
  ) => {
    events.push({
      id: `evt_${String(++seq).padStart(4, "0")}`,
      ts: seq * 1000, // synthetic — DevTools exports carry no timing
      type,
      url: partial.url ?? currentUrl,
      target:
        partial.locators && partial.locators.length > 0
          ? {
              tag: partial.tag ?? "element",
              locators: partial.locators,
              a11y: null,
              boundingBox: null,
              isCanvas: false,
              canvasRelative: null,
            }
          : null,
      value: partial.value ?? null,
      screenshotBefore: null,
      screenshotAfter: null,
      domSnapshotAfter: null,
      network: [],
    });
  };

  for (const step of recording.steps) {
    switch (step.type) {
      case "setViewport":
        viewport = {
          width: step.width ?? 1280,
          height: step.height ?? 720,
          dpr: step.deviceScaleFactor ?? 1,
        };
        break;
      case "navigate": {
        currentUrl = step.url ?? currentUrl;
        if (events.length === 0) origin = new URL(currentUrl).origin;
        push("navigation", { url: currentUrl });
        break;
      }
      case "click":
      case "doubleClick": {
        const locators = mapSelectors(step.selectors);
        if (locators.length === 0) break; // xpath-only step — nothing usable
        push(step.type === "click" ? "click" : "dblclick", {
          locators,
          tag: tagFromSelectors(step.selectors),
        });
        break;
      }
      case "change": {
        const locators = mapSelectors(step.selectors);
        if (locators.length === 0) break;
        const flat = (step.selectors ?? []).flat().join(" ");
        const value = PASSWORDISH.test(flat) ? "«redacted:password»" : (step.value ?? "");
        push("input", { locators, tag: tagFromSelectors(step.selectors), value });
        break;
      }
      case "keyDown": {
        if (["Enter", "Escape", "Tab"].includes(step.key ?? "")) {
          push("keypress", { value: step.key ?? null, locators: [] });
        }
        break;
      }
      default:
        break; // waitForElement / keyUp / scroll etc. — no trace equivalent needed
    }
  }

  return RecordingTraceSchema.parse({
    traceVersion: 1,
    recordedAt: new Date().toISOString(),
    origin,
    viewport,
    userAgent: `devtools-recorder-import${recording.title ? `: ${recording.title}` : ""}`,
    events,
    finalScreenshot: null,
    consoleErrors: [],
    assertionMarkers: [],
  });
}
