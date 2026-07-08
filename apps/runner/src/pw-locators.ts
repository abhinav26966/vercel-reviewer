import type { Locator as PwLocator, Page } from "playwright";
import type { Locator } from "@flowguard/schemas";

/** Per-locator timeout and total step locate budget (doc 04 §3). */
export const PER_LOCATOR_TIMEOUT_MS = 2500;
export const LOCATE_BUDGET_MS = 8000;

export class LocatorMissError extends Error {
  constructor(
    readonly tried: Locator[],
    readonly budgetMs: number,
  ) {
    super(
      `no locator matched within ${budgetMs}ms: ${tried
        .map((l) => `${l.kind}=${JSON.stringify(l.value)}`)
        .join(" → ")}`,
    );
    this.name = "LocatorMissError";
  }
}

export function buildLocator(page: Page, locator: Locator): PwLocator {
  switch (locator.kind) {
    case "testid":
      return page.getByTestId(locator.value);
    case "role":
      return page.getByRole(locator.value.role as Parameters<Page["getByRole"]>[0], {
        name: locator.value.name,
      });
    case "text":
      return page.getByText(locator.value);
    case "label":
      return page.getByLabel(locator.value);
    case "placeholder":
      return page.getByPlaceholder(locator.value);
    case "css":
      return page.locator(locator.value);
  }
}

/**
 * Try the stack in priority order: each locator gets a short window to attach;
 * the first that resolves wins (doc 02 §3). Total budget caps the step.
 */
export async function resolveLocator(page: Page, stack: Locator[]): Promise<PwLocator> {
  const deadline = Date.now() + LOCATE_BUDGET_MS;
  for (const spec of stack) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const timeout = Math.min(PER_LOCATOR_TIMEOUT_MS, remaining);
    const candidate = buildLocator(page, spec).first();
    try {
      await candidate.waitFor({ state: "attached", timeout });
      return candidate;
    } catch {
      // next locator in the stack
    }
  }
  throw new LocatorMissError(stack, LOCATE_BUDGET_MS);
}
