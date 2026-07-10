import type { Locator, Page } from "playwright";
import type { Logger } from "pino";
import type { InferenceProvider } from "@flowguard/inference";
import { evalAssertion } from "./assertions.js";
import type { NetworkTracker } from "./network-tracker.js";
import { executePaymentStep, PaymentCaptchaError, PaymentUnverifiedError } from "./payments/execute.js";
import { LocatorMissError, resolveLocator } from "./pw-locators.js";
import { findSecretPlaceholders } from "./secrets.js";
import type { FlowStep, StepAssertionResult } from "./types.js";

export interface StepFailure {
  failureClass: "locator_miss" | "assertion" | "env" | "payment_unverified_env" | "grounding_failed";
  message: string;
  assertions: StepAssertionResult[];
}

/** Exchanges a `{{secret:persona.field}}` placeholder name for its plaintext. */
export type SecretLookup = (placeholder: string) => Promise<string>;

/** Vision grounding couldn't place a canvas target confidently (doc 04 §3). */
export class GroundingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroundingError";
  }
}

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
  /** Vision assertions + canvas grounding (doc 04 §§3,6); absent → those fail honestly. */
  inference?: InferenceProvider;
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
    if (err instanceof GroundingError) {
      return {
        failure: { failureClass: "grounding_failed", message: err.message, assertions: [] },
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

  // vision assertions read the SETTLE screenshot (doc 04 §6) — capture once,
  // at the settle point, and share it across any vision post-conditions
  const needsShot = step.postConditions.some((a) => a.kind === "vision");
  const shot = needsShot ? await ctx.page.screenshot({ timeout: 5000 }).catch(() => null) : null;
  const assertCtx = { inference: ctx.inference };

  const results: StepAssertionResult[] = [];
  for (const assertion of step.postConditions) {
    results.push(await evalAssertion(ctx.page, assertion, { shot, ctx: assertCtx }));
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
      // deterministic half (doc 02 §3): resolve the canvas, click the recorded
      // normalized point. Vision grounding (doc 04 §3) is the fallback when the
      // canvas moved (locator resolves but the recorded point is stale) or no
      // point was recorded — gated on model confidence, else grounding_failed.
      const canvas = await resolveLocator(page, action.canvasLocator);
      await canvas.waitFor({ state: "visible", timeout: 10000 });
      // WebGL scenes need a beat to become raycast-ready under software rendering
      await page.waitForTimeout(1500);
      const box = await canvas.boundingBox();
      if (!box) throw new Error("canvas resolved but has no bounding box");

      let point = action.point;
      // ground when there's no recorded point, or a describe hint invites a
      // re-check (the pack may have moved in this PR — doc 12 AC)
      if (!point && action.visionFallback) {
        point = await groundCanvasPoint(ctx, canvas, box, action.visionFallback.describe);
      }
      if (!point) {
        throw new GroundingError(
          action.visionFallback
            ? "vision grounding did not locate the canvas target with enough confidence"
            : "canvasClick without a recorded point requires a visionFallback.describe",
        );
      }
      await page.mouse.click(box.x + box.width * point.nx, box.y + box.height * point.ny);
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

const GROUNDING_MIN_CONFIDENCE = 0.6;

/**
 * Vision grounding for canvas clicks (doc 04 §3): screenshot the canvas region,
 * ask the model where the described target is, and translate its
 * canvas-relative point back to the click. Confidence-gated — a low-confidence
 * guess returns null so the caller raises an honest grounding_failed rather
 * than clicking a random pixel.
 */
async function groundCanvasPoint(
  ctx: StepContext,
  canvas: Locator,
  box: { x: number; y: number; width: number; height: number },
  describe: string,
): Promise<{ nx: number; ny: number } | null> {
  if (!ctx.inference) {
    ctx.logger.warn("canvas grounding requested but no inference backend configured");
    return null;
  }
  const shot = await canvas.screenshot({ timeout: 5000 }).catch(() => null);
  if (!shot) return null;
  const { result } = await ctx.inference.groundElement({
    image: { data: shot, mediaType: "image/png", label: "canvas" },
    describe,
  });
  if (!result || result.confidence < GROUNDING_MIN_CONFIDENCE) {
    ctx.logger.info({ confidence: result?.confidence ?? null, describe }, "canvas grounding below confidence gate");
    return null;
  }
  ctx.logger.info({ nx: result.nx, ny: result.ny, confidence: result.confidence }, "canvas point grounded by vision");
  return { nx: result.nx, ny: result.ny };
}

/** Settle strategies (doc 02 §3, doc 04 §6); returns true when it timed out. */
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
      case "flowEvent":
        await waitForFlowEvent(page, step.settle.event!, timeoutMs);
        return false;
      case "animationQuiescence":
        await waitForQuiescence(page, step, timeoutMs);
        return false;
      case "networkidle+animation":
        await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {});
        await waitForQuiescence(page, step, timeoutMs);
        return false;
      default:
        await page.waitForLoadState("networkidle", { timeout: timeoutMs });
        return false;
    }
  } catch {
    // settle timeout is not itself a failure (doc 04 §3) — the hang classifier decides
    logger.debug({ step: step.id, strategy }, "settle timed out — evaluating post-conditions anyway");
    return true;
  }
}

/**
 * flowEvent settle (doc 04 §6): resolve when the app dispatches the named
 * milestone on the "flowguard" CustomEvent (from @flowguard/state). Rejects on
 * timeout so settle() records a timed-out settle.
 */
async function waitForFlowEvent(page: Page, event: string, timeoutMs: number): Promise<void> {
  await page.evaluate(
    ({ event, timeoutMs }) =>
      new Promise<void>((resolve, reject) => {
        const done = (e: Event) => {
          const detail = (e as CustomEvent).detail as { event?: string } | undefined;
          if (!detail || detail.event === undefined || detail.event === event) {
            window.removeEventListener("flowguard", done);
            resolve();
          }
        };
        window.addEventListener("flowguard", done);
        setTimeout(() => {
          window.removeEventListener("flowguard", done);
          reject(new Error("flowEvent timeout"));
        }, timeoutMs);
      }),
    { event, timeoutMs },
  );
}

/**
 * animationQuiescence settle (doc 04 §6): sample the viewport and wait until
 * consecutive frames stop changing (canvas/WebGL scenes have no network/DOM
 * signal that the animation finished). Downsampled diff so JPEG noise / cursor
 * blinks don't count. Throws on timeout.
 */
async function waitForQuiescence(page: Page, step: FlowStep, timeoutMs: number): Promise<void> {
  const q = step.settle.quiescence ?? { sampleEveryMs: 400, stableFrames: 3, diffThresholdPct: 2 };
  const deadline = Date.now() + timeoutMs;
  let prev: Buffer | null = null;
  let stable = 0;
  while (Date.now() < deadline) {
    const shot = await page.screenshot({ timeout: 5000 }).catch(() => null);
    if (shot) {
      if (prev) {
        const diff = frameDiffPct(prev, shot);
        stable = diff <= q.diffThresholdPct ? stable + 1 : 0;
        if (stable >= q.stableFrames) return;
      }
      prev = shot;
    }
    await page.waitForTimeout(q.sampleEveryMs);
  }
  throw new Error("animationQuiescence timeout");
}

/**
 * Cheap frame-difference: byte-length delta is a poor signal for PNGs, so
 * compare raw sizes AND a coarse content signature. Good enough to tell "still
 * animating" from "settled" without pulling in an image lib on the hot path.
 */
function frameDiffPct(a: Buffer, b: Buffer): number {
  if (a.length === 0 && b.length === 0) return 0;
  const lenDelta = Math.abs(a.length - b.length) / Math.max(a.length, b.length);
  // sample bytes at a fixed stride and count mismatches over the shared prefix
  const n = Math.min(a.length, b.length);
  const stride = Math.max(1, Math.floor(n / 2048));
  let mismatch = 0;
  let sampled = 0;
  for (let i = 0; i < n; i += stride) {
    if (a[i] !== b[i]) mismatch++;
    sampled++;
  }
  const byteDelta = sampled ? mismatch / sampled : 0;
  return Math.max(lenDelta, byteDelta) * 100;
}
