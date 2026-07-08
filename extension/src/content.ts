/**
 * Content script (doc 03 A2): capture-phase event listeners; computes locator
 * stacks, bounding boxes, canvas coordinates, and a trimmed a11y outline; redacts
 * secrets at source; posts enriched events to the service worker.
 */
import { a11yPath, accessibleName, canvasInfo, computeLocators, elementRole } from "./locators.js";
import { redactInputValue } from "./redact.js";

interface CapturedEvent {
  type: "click" | "dblclick" | "input" | "keypress" | "scroll" | "select";
  ts: number;
  url: string;
  target: {
    tag: string;
    locators: ReturnType<typeof computeLocators>;
    a11y: { role: string; name: string; path: string[] } | null;
    boundingBox: { x: number; y: number; w: number; h: number } | null;
    isCanvas: boolean;
    canvasRelative: { nx: number; ny: number } | null;
  } | null;
  value: string | null;
}

let recording = false;
const inputDebounce = new Map<Element, { timer: number; value: string }>();

function describeTarget(el: Element, clientX?: number, clientY?: number): CapturedEvent["target"] {
  const rect = el.getBoundingClientRect();
  const canvas = canvasInfo(el, clientX ?? rect.left + rect.width / 2, clientY ?? rect.top + rect.height / 2);
  const role = elementRole(el);
  return {
    tag: el.tagName.toLowerCase(),
    locators: computeLocators(el),
    a11y: role ? { role, name: accessibleName(el), path: a11yPath(el) } : null,
    boundingBox:
      rect.width || rect.height
        ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
        : null,
    isCanvas: canvas.isCanvas,
    canvasRelative: canvas.canvasRelative,
  };
}

function send(event: CapturedEvent): void {
  void chrome.runtime.sendMessage({ kind: "flowguard:event", event }).catch(() => {});
}

function onPointer(type: "click" | "dblclick") {
  return (e: MouseEvent) => {
    if (!recording || !(e.target instanceof Element)) return;
    send({
      type,
      ts: Date.now(),
      url: location.href,
      target: describeTarget(e.target, e.clientX, e.clientY),
      value: null,
    });
  };
}

function flushInput(el: Element): void {
  const pending = inputDebounce.get(el);
  if (!pending) return;
  clearTimeout(pending.timer);
  inputDebounce.delete(el);
  send({
    type: "input",
    ts: Date.now(),
    url: location.href,
    target: describeTarget(el),
    value: redactInputValue(el, pending.value),
  });
}

function onInput(e: Event): void {
  if (!recording || !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) return;
  const el = e.target;
  const existing = inputDebounce.get(el);
  if (existing) clearTimeout(existing.timer);
  inputDebounce.set(el, {
    value: el.value,
    timer: window.setTimeout(() => flushInput(el), 600),
  });
}

function onKeydown(e: KeyboardEvent): void {
  if (!recording) return;
  if (!["Enter", "Escape", "Tab"].includes(e.key)) return;
  // flush any pending input first so ordering stays truthful
  if (e.target instanceof Element) flushInput(e.target);
  send({
    type: "keypress",
    ts: Date.now(),
    url: location.href,
    target: e.target instanceof Element ? describeTarget(e.target) : null,
    value: e.key,
  });
}

function onChange(e: Event): void {
  if (!recording || !(e.target instanceof HTMLSelectElement)) return;
  send({
    type: "select",
    ts: Date.now(),
    url: location.href,
    target: describeTarget(e.target),
    value: e.target.value,
  });
}

let scrollTimer: number | null = null;
function onScroll(): void {
  if (!recording) return;
  if (scrollTimer) clearTimeout(scrollTimer);
  scrollTimer = window.setTimeout(() => {
    send({ type: "scroll", ts: Date.now(), url: location.href, target: null, value: String(window.scrollY) });
  }, 400);
}

// clicks flush pending inputs from other fields (value-then-click ordering)
document.addEventListener(
  "click",
  () => {
    for (const el of [...inputDebounce.keys()]) flushInput(el);
  },
  true,
);
document.addEventListener("click", onPointer("click"), true);
document.addEventListener("dblclick", onPointer("dblclick"), true);
document.addEventListener("input", onInput, true);
document.addEventListener("keydown", onKeydown, true);
document.addEventListener("change", onChange, true);
document.addEventListener("scroll", onScroll, true);

/** Trimmed DOM outline for domSnapshotAfter (doc 02 §1: a11y-tree, not full HTML). */
function domOutline(node: Element, depth: number): unknown {
  if (depth > 5) return undefined;
  const role = elementRole(node);
  const testid = node.getAttribute("data-testid");
  const children = Array.from(node.children)
    .map((c) => domOutline(c, depth + 1))
    .filter(Boolean);
  if (!role && !testid && children.length === 0) return undefined;
  return {
    tag: node.tagName.toLowerCase(),
    ...(role ? { role, name: accessibleName(node).slice(0, 60) } : {}),
    ...(testid ? { testid } : {}),
    ...(children.length ? { children } : {}),
  };
}

// a fresh document loads with recording=false — ask the service worker whether a
// recording session covers this tab (survives navigations, doc 03 A2)
void chrome.runtime
  .sendMessage({ kind: "flowguard:query-recording" })
  .then((res: { recording?: boolean } | undefined) => {
    if (res?.recording) recording = true;
  })
  .catch(() => {});

chrome.runtime.onMessage.addListener((msg: { kind: string }, _sender, sendResponse) => {
  if (msg.kind === "flowguard:set-recording") {
    recording = (msg as { recording: boolean } & typeof msg).recording;
    sendResponse({ ok: true });
  }
  if (msg.kind === "flowguard:dom-snapshot") {
    sendResponse({ outline: domOutline(document.body, 0) ?? { tag: "body" } });
  }
  return true;
});
