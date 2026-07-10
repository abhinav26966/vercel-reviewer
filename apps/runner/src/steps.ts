import type { Page } from "playwright";
import type { Logger } from "pino";
import { evalAssertion } from "./assertions.js";
import type { NetworkTracker } from "./network-tracker.js";
import { executePaymentStep, PaymentCaptchaError, PaymentUnverifiedError } from "./payments/execute.js";
import { LocatorMissError, resolveLocator } from "./pw-locators.js";
import { findSecretPlaceholders } from "./secrets.js";
import type { FlowStep, StepAssertionResult } from "./types.js";

export interface StepFailure {
  failureClass: "locator_miss" | "assertion" | "env" | "payment_unverified_env";
  message: string;
  assertions: StepAssertionResult[];
}

/** Exchanges a `{{secret:persona.field}}` placeholder name for its plaintext. */
export type SecretLookup = (placeholder: string) => Promise<string>;

export interface StepContext {
  page: Page;
  baseUrl: string;
  tracker: NetworkTracker;
  logger: Logger;
  /** Absent → specs with secret placeholders fail closed. */
  lookupSecret?: SecretLookup;
  /** Direct `sec_*` reference resolution (payment card fields, doc 07 §6). */
  resolveRef?: (ref: string) => Promise<string>;
  /** Payment bundle from the config resolution (doc 07 §6); null = unconfigured. */
  payment?: { provider: string; cardRef: string; expiry: string; cvcRef: string } | null;
}

export interface StepOutcome {
  failure: StepFailure | null;
  /** settle duration in ms (doc 04 §3: timing stops at settle) */
  settleMs: number;
  /** the settle strategy hit its timeout (hang-classifier input, doc 04 §4) */
  settleTimedOut: boolean;
}

/** Act + settle + assert. */
export async function runStepOnce(ctx: StepContext, step: FlowStep): Promise<StepOutcome> {
  const urlBefore = ctx.page.url();
  try {
    await act(ctx, step);
  } catch (err) {
    if (err instanceof LocatorMissError) {
      return {
        failure: { failureClass: "locator_miss", message: err.message, assertions: [] },
        settleMs: 0,
        settleTimedOut: false,
      };
    }
    if (err instanceof PaymentUnverifiedError || err instanceof PaymentCaptchaError) {
      // the live-mode guard or a CAPTCHA wall (doc 07 §6/§7): 🟣, never a flow failure
      return {
        failure: { failureClass: "payment_unverified_env", message: err.message, assertions: [] },
        settleMs: 0,
        settleTimedOut: false,
      };
    }
    return {
      failure: {
        failureClass: "env",
        message: err instanceof Error ? err.message.split("\n")[0]! : String(err),
        assertions: [],
      },
      settleMs: 0,
      settleTimedOut: false,
    };
  }

  const settleStart = Date.now();
  const settleTimedOut = await settle(ctx, step, urlBefore);
  const settleMs = Date.now() - settleStart;

  const results: StepAssertionResult[] = [];
  for (const assertion of step.postConditions) {
    results.push(await evalAssertion(ctx.page, assertion));
  }
  const failedAssertion = results.find((r) => !r.pass);
  if (failedAssertion) {
    return {
      failure: {
        failureClass: "assertion",
        message: failedAssertion.message ?? `${failedAssertion.kind} assertion failed`,
        assertions: results,
      },
      settleMs,
      settleTimedOut,
    };
  }
  return { failure: null, settleMs, settleTimedOut };
}

async function act(ctx: StepContext, step: FlowStep): Promise<void> {
  const { page, baseUrl } = ctx;
  const action = step.action;
  switch (action.type) {
    case "navigate":
      await page.goto(baseUrl + action.path, { waitUntil: "load", timeout: 30000 });
      return;
    case "click":
      await (await resolveLocator(page, action.locators)).click();
      return;
    case "type": {
      const locator = await resolveLocator(page, action.locators);
      const placeholders = findSecretPlaceholders(action.value);
      if (placeholders.length === 0) {
        await locator.fill(action.value);
        return;
      }
      // Secrets are typed via CDP Input.insertText: the plaintext never appears in
      // a Playwright API call, so it cannot enter trace actions (doc 04 §3).
      await typeSecretValue(ctx, locator, action.value, placeholders);
      return;
    }
    case "press": {
      if (action.locators) {
        await (await resolveLocator(page, action.locators)).press(action.key);
      } else {
        await page.keyboard.press(action.key);
      }
      return;
    }
    case "waitFor": {
      const loc = await resolveLocator(page, action.locators);
      await loc.waitFor({ state: action.state, timeout: 10000 });
      return;
    }
    case "select":
      await (await resolveLocator(page, action.locators)).selectOption(action.value);
      return;
    case "scroll": {
      if (action.locators) {
        await (await resolveLocator(page, action.locators)).scrollIntoViewIfNeeded();
      } else if (action.y !== undefined) {
        await page.mouse.wheel(0, action.y);
      }
      return;
    }
    case "canvasClick": {
      // deterministic half (doc 02 §3): normalized point → absolute coords at the
      // spec viewport. Vision-grounding fallback lands in Phase 12.
      const canvas = await resolveLocator(page, action.canvasLocator);
      await canvas.waitFor({ state: "visible", timeout: 10000 });
      // WebGL scenes need a beat to become raycast-ready under software rendering
      // (Phase 2 lesson); replaced by a pre-click quiescence check in Phase 12
      await page.waitForTimeout(1500);
      const box = await canvas.boundingBox();
      if (!box) throw new Error("canvas resolved but has no bounding box");
      if (!action.point) {
        throw new Error("canvasClick without a recorded point requires vision grounding (Phase 12)");
      }
      await page.mouse.click(box.x + box.width * action.point.nx, box.y + box.height * action.point.ny);
      return;
    }
    case "payment":
      await executePaymentStep(ctx, action);
      return;
    default:
      throw new Error(`action type "${action.type}" lands in a later phase`);
  }
}

async function typeSecretValue(
  ctx: StepContext,
  locator: Awaited<ReturnType<typeof resolveLocator>>,
  template: string,
  placeholders: string[],
): Promise<void> {
  const { page, baseUrl } = ctx;
  if (!ctx.lookupSecret) {
    throw new Error(`secret placeholder used but no credentials were resolved for this target`);
  }
  // Origin scoping (doc 07 §4.5): secrets are typed ONLY into the deployment host.
  const pageHost = new URL(page.url()).host;
  const depHost = new URL(baseUrl).host;
  if (pageHost !== depHost) {
    throw new Error(`refusing to type a secret into ${pageHost} (deployment host is ${depHost})`);
  }
  let text = template;
  for (const name of placeholders) {
    const plaintext = await ctx.lookupSecret(name);
    text = text.replaceAll(`{{secret:${name}}}`, plaintext);
  }
  await locator.click();
  await locator.fill("");
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.insertText", { text });
  } finally {
    await session.detach().catch(() => {});
  }
}

/**
 * Freshly-READY Vercel previews can take a few seconds to become reachable at
 * the edge (deployment_status fires on READY, not on propagation). Retry the
 * initial navigation with backoff before declaring the deployment unreachable.
 */
export async function gotoWithRetry(
  page: Page,
  url: string,
  logger: Logger,
  opts: { attempts?: number; timeoutMs?: number; backoffMs?: number } = {},
): Promise<void> {
  const attempts = opts.attempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 25000;
  const backoffMs = opts.backoffMs ?? 5000;
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
      return;
    } catch (err) {
      lastErr = err;
      logger.warn(
        { url, attempt: i, attempts },
        "initial navigation attempt failed — deployment may still be propagating",
      );
      if (i < attempts) await page.waitForTimeout(backoffMs);
    }
  }
  throw lastErr;
}

/** Settle strategies networkidle|navigation|timeout; returns true when timed out. */
async function settle(ctx: StepContext, step: FlowStep, urlBefore: string): Promise<boolean> {
  const { page, logger } = ctx;
  const { strategy, timeoutMs } = step.settle;
  try {
    switch (strategy) {
      case "navigation": {
        const deadline = Date.now() + timeoutMs;
        while (page.url() === urlBefore && Date.now() < deadline) {
          await page.waitForTimeout(100);
        }
        await page.waitForLoadState("load", { timeout: Math.max(1, deadline - Date.now()) });
        return false;
      }
      case "networkidle":
        await page.waitForLoadState("networkidle", { timeout: timeoutMs });
        return false;
      case "timeout":
        await page.waitForTimeout(timeoutMs);
        return false;
      default:
        // animationQuiescence etc. land in Phase 12; bounded networkidle for now
        await page.waitForLoadState("networkidle", { timeout: timeoutMs });
        return false;
    }
  } catch {
    // settle timeout is not itself a failure (doc 04 §3) — the hang classifier decides
    logger.debug({ step: step.id, strategy }, "settle timed out — evaluating post-conditions anyway");
    return true;
  }
}
