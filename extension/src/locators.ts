/**
 * Locator-stack computation (doc 03 A2): priority testid → role+accessible name →
 * text/label/placeholder → short unique CSS. xpath is forbidden by doc 02 §3.
 * Runs inside the recorded page (content script) — DOM APIs only, no deps.
 */

export interface LocatorJson {
  kind: "testid" | "role" | "text" | "label" | "placeholder" | "css";
  value: string | { role: string; name: string };
}

const IMPLICIT_ROLES: Record<string, string> = {
  a: "link",
  button: "button",
  select: "combobox",
  textarea: "textbox",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  nav: "navigation",
  main: "main",
  img: "image",
};

export function elementRole(el: Element): string | null {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "input") {
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (type === "button" || type === "submit") return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    return "textbox";
  }
  return IMPLICIT_ROLES[tag] ?? null;
}

/** Simplified accessible-name computation (aria-label → labelledby → label[for] → text). */
export function accessibleName(el: Element): string {
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel?.trim()) return ariaLabel.trim();
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent?.trim() ?? "")
      .filter(Boolean);
    if (parts.length) return parts.join(" ");
  }
  if (el.id) {
    const label = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label?.textContent?.trim()) return label.textContent.trim();
  }
  const closestLabel = el.closest("label");
  if (closestLabel?.textContent?.trim()) return closestLabel.textContent.trim();
  const text = (el as HTMLElement).innerText ?? el.textContent ?? "";
  return text.trim().slice(0, 80);
}

function cssPath(el: Element): string {
  // short, reasonably-unique CSS: prefer #id anchors, else tag:nth-of-type chain (depth ≤ 4)
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && parts.length < 4) {
    if (node.id) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break;
    }
    const tag = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
    parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})` : tag);
    node = parent;
  }
  return parts.join(" > ");
}

export function computeLocators(el: Element): LocatorJson[] {
  const locators: LocatorJson[] = [];
  const doc = el.ownerDocument;

  const testid = el.getAttribute("data-testid");
  if (testid) locators.push({ kind: "testid", value: testid });

  const role = elementRole(el);
  const name = accessibleName(el);
  if (role && name) locators.push({ kind: "role", value: { role, name } });

  // text locator only for short, unique-ish visible text on interactive elements
  const text = ((el as HTMLElement).innerText ?? "").trim();
  if (text && text.length <= 50 && ["a", "button"].includes(el.tagName.toLowerCase())) {
    locators.push({ kind: "text", value: text });
  }

  const placeholder = el.getAttribute("placeholder");
  if (placeholder) locators.push({ kind: "placeholder", value: placeholder });

  const ariaOrLabelName = el.tagName.toLowerCase() === "input" && name && !placeholder ? name : null;
  if (ariaOrLabelName && !locators.some((l) => l.kind === "label")) {
    const hasRealLabel =
      el.closest("label") !== null ||
      (el.id && doc.querySelector(`label[for="${CSS.escape(el.id)}"]`) !== null);
    if (hasRealLabel) locators.push({ kind: "label", value: ariaOrLabelName });
  }

  // css last resort — always present so every stack has ≥1, and interactive
  // elements with a testid or role reach the compiler's ≥2 bar
  locators.push({ kind: "css", value: cssPath(el) });
  return locators;
}

export interface CanvasInfo {
  isCanvas: boolean;
  canvasRelative: { nx: number; ny: number } | null;
}

export function canvasInfo(el: Element, clientX: number, clientY: number): CanvasInfo {
  const canvas = el.tagName.toLowerCase() === "canvas" ? el : el.querySelector("canvas");
  if (!canvas) return { isCanvas: false, canvasRelative: null };
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return { isCanvas: false, canvasRelative: null };
  const nx = (clientX - rect.left) / rect.width;
  const ny = (clientY - rect.top) / rect.height;
  return {
    isCanvas: true,
    canvasRelative: {
      nx: Math.min(1, Math.max(0, Number(nx.toFixed(4)))),
      ny: Math.min(1, Math.max(0, Number(ny.toFixed(4)))),
    },
  };
}

/** Trimmed a11y-ish outline of the element's ancestry (doc 02 §1 a11y.path). */
export function a11yPath(el: Element): string[] {
  const path: string[] = [];
  let node: Element | null = el;
  while (node && path.length < 6) {
    const role = elementRole(node);
    if (role) {
      const name = accessibleName(node);
      path.unshift(name ? `${role}[name=${name.slice(0, 40)}]` : role);
    }
    node = node.parentElement;
  }
  return path;
}
