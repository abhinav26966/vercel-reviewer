import type { Page } from "playwright";
import type { Assertion, StepAssertionResult } from "./types.js";
import { buildLocator } from "./pw-locators.js";

const ASSERT_TIMEOUT_MS = 3000;

/** Pure URL matcher — unit-testable without a browser. */
export function evalUrlAssertion(
  currentUrl: string,
  assertion: Extract<Assertion, { kind: "url" }>,
): { pass: boolean; message?: string } {
  const path = new URL(currentUrl).pathname;
  if (assertion.assert === "pathMatches") {
    const pass = new RegExp(assertion.value).test(path);
    return pass ? { pass } : { pass, message: `path ${path} !~ /${assertion.value}/` };
  }
  const pass = assertion.value.startsWith("/")
    ? path === assertion.value
    : currentUrl === assertion.value;
  return pass ? { pass } : { pass, message: `url ${currentUrl} !== ${assertion.value}` };
}

async function evalDomAssertion(
  page: Page,
  assertion: Extract<Assertion, { kind: "dom" }>,
): Promise<{ pass: boolean; message?: string }> {
  // value comparisons poll until the deadline — the settle point marks when the
  // condition SHOULD hold, but responses/renders may land moments later
  const deadline = Date.now() + ASSERT_TIMEOUT_MS;
  let result = await evalDomAssertionOnce(page, assertion);
  while (!result.pass && Date.now() < deadline) {
    await page.waitForTimeout(200);
    result = await evalDomAssertionOnce(page, assertion);
  }
  return result;
}

async function evalDomAssertionOnce(
  page: Page,
  assertion: Extract<Assertion, { kind: "dom" }>,
): Promise<{ pass: boolean; message?: string }> {
  // assertions may carry a single locator (doc 02 §3); try the stack in order
  let lastError = "";
  for (const spec of assertion.locators) {
    const loc = buildLocator(page, spec).first();
    try {
      switch (assertion.assert) {
        case "visible":
          await loc.waitFor({ state: "visible", timeout: ASSERT_TIMEOUT_MS });
          return { pass: true };
        case "hidden":
          // waitFor(hidden) passes when the element is hidden OR absent
          await loc.waitFor({ state: "hidden", timeout: ASSERT_TIMEOUT_MS });
          return { pass: true };
        case "enabled": {
          await loc.waitFor({ state: "visible", timeout: ASSERT_TIMEOUT_MS });
          if (await loc.isEnabled()) return { pass: true };
          lastError = "element is disabled";
          continue;
        }
        case "textMatches": {
          await loc.waitFor({ state: "visible", timeout: ASSERT_TIMEOUT_MS });
          const text = (await loc.textContent()) ?? "";
          if (new RegExp(String(assertion.value)).test(text)) return { pass: true };
          lastError = `text ${JSON.stringify(text.slice(0, 80))} !~ /${assertion.value}/`;
          continue;
        }
        case "countEquals": {
          const count = await buildLocator(page, spec).count();
          if (count === assertion.value) return { pass: true };
          lastError = `count ${count} !== ${assertion.value}`;
          continue;
        }
        case "attrEquals": {
          await loc.waitFor({ state: "attached", timeout: ASSERT_TIMEOUT_MS });
          const val = await loc.getAttribute(assertion.attr!);
          if (val === String(assertion.value)) return { pass: true };
          lastError = `[${assertion.attr}]=${JSON.stringify(val)} !== ${assertion.value}`;
          continue;
        }
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message.split("\n")[0]! : String(err);
    }
  }
  return { pass: false, message: lastError || "no locator in the stack matched" };
}

/** Evaluate a post-condition. Phase 2 supports dom|url; others report unsupported. */
export async function evalAssertion(page: Page, assertion: Assertion): Promise<StepAssertionResult> {
  if (assertion.kind === "url") {
    const r = evalUrlAssertion(page.url(), assertion);
    return { kind: "url", pass: r.pass, ...(r.message ? { message: r.message } : {}) };
  }
  if (assertion.kind === "dom") {
    const r = await evalDomAssertion(page, assertion);
    return { kind: "dom", pass: r.pass, ...(r.message ? { message: r.message } : {}) };
  }
  return {
    kind: assertion.kind,
    pass: false,
    message: `assertion kind "${assertion.kind}" lands in a later phase`,
  };
}
