import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import type { Logger } from "pino";
import { RunFlowResultSchema } from "@flowguard/schemas";
import { evalAssertion } from "./assertions.js";
import { artifactKey, type ArtifactStore } from "./artifacts.js";
import { NetworkTracker } from "./network-tracker.js";
import { LocatorMissError, resolveLocator } from "./pw-locators.js";
import type { ExecuteFlowJob, FlowStep, RunFlowResult, StepAssertionResult, StepResult } from "./types.js";

export interface ExecuteFlowOptions {
  job: ExecuteFlowJob;
  logger: Logger;
  artifacts: ArtifactStore;
  /** Checked between steps (doc 01 §6 cancellation). */
  shouldAbort?: () => Promise<boolean>;
  headless?: boolean;
}

interface StepFailure {
  failureClass: "locator_miss" | "assertion" | "env";
  message: string;
  assertions: StepAssertionResult[];
}

/**
 * Deterministic replay loop (doc 04 §§2–3): context setup → bypass → per step
 * act/settle/assert with one deterministic retry → failure bundle → artifacts.
 */
export async function executeFlow(opts: ExecuteFlowOptions): Promise<RunFlowResult> {
  const { job, logger, artifacts } = opts;
  const spec = job.spec;
  const workdir = await mkdtemp(path.join(tmpdir(), "flowguard-run-"));
  const harPath = path.join(workdir, "network.har");
  const tracePath = path.join(workdir, "trace.zip");

  const consoleLines: Array<{ ts: number; text: string }> = [];
  const consoleErrors: Array<{ ts?: number; text: string }> = [];
  let pageCrashed = false;

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  const steps: StepResult[] = [];
  const artifactKeys: Record<string, string | null> = {
    video: null,
    trace: null,
    har: null,
    console: null,
    coverage: null,
  };
  let failedStepId: string | null = null;
  let failure: StepFailure | null = null;
  let outcome: "passed" | "failed" | "error" | "skipped" = "passed";
  const flowStart = Date.now();
  const tracker = new NetworkTracker();

  try {
    browser = await chromium.launch({
      headless: opts.headless ?? true,
      // software WebGL so canvas flows render identically everywhere (doc 04 §2)
      args: ["--use-angle=swiftshader"],
    });
    context = await browser.newContext({
      viewport: { width: spec.viewport.width, height: spec.viewport.height },
      deviceScaleFactor: spec.viewport.dpr,
      recordVideo: job.collect.video ? { dir: workdir } : undefined,
      recordHar: job.collect.har ? { path: harPath, content: "omit" } : undefined,
    });
    await context.tracing.start({ screenshots: true, snapshots: true });

    const page = await context.newPage();
    tracker.attach(page);
    page.on("console", (msg) => {
      const line = { ts: Date.now() - flowStart, text: `[${msg.type()}] ${msg.text()}` };
      consoleLines.push(line);
      if (msg.type() === "error") consoleErrors.push({ ts: line.ts, text: msg.text() });
    });
    page.on("pageerror", (err) => {
      consoleErrors.push({ ts: Date.now() - flowStart, text: `pageerror: ${err.message}` });
    });
    page.on("crash", () => {
      pageCrashed = true;
    });

    installOriginGuardAndBypass(page, job, logger);

    // initial navigation to the deployment (bypass cookie handshake happens here)
    const baseUrl = job.target.deploymentUrl.replace(/\/$/, "");
    try {
      await page.goto(baseUrl + spec.startPath, { waitUntil: "load", timeout: 30000 });
    } catch (err) {
      logger.error({ err }, "initial navigation failed");
      outcome = "error";
      failure = {
        failureClass: "env",
        message: `deployment unreachable: ${err instanceof Error ? err.message.split("\n")[0] : err}`,
        assertions: [],
      };
    }
    if (outcome === "passed" && (await isProtectionChallenge(page))) {
      outcome = "error";
      failure = {
        failureClass: "env",
        message: "Vercel deployment protection challenge — bypass secret missing or rejected",
        assertions: [],
      };
    }

    for (const step of outcome === "passed" ? spec.steps : []) {
      if (opts.shouldAbort && (await opts.shouldAbort())) {
        logger.info({ step: step.id }, "abort requested — stopping between steps");
        outcome = "skipped";
        break;
      }

      const stepStart = Date.now();
      let attemptFailure = await runStepOnce(page, baseUrl, step, tracker, logger);
      if (attemptFailure) {
        // one deterministic retry: page may have been mid-hydration (doc 04 §3)
        logger.warn({ step: step.id, reason: attemptFailure.message }, "step failed — deterministic retry");
        attemptFailure = await runStepOnce(page, baseUrl, step, tracker, logger);
      }
      const stepEnd = Date.now();

      const screenshotKey = attemptFailure
        ? await captureFailureBundle(page, step, artifacts, job, tracker, consoleLines, logger)
        : null;

      steps.push({
        id: step.id,
        durationMs: stepEnd - stepStart,
        settleMs: 0, // measured properly with the perf work in Phase 7
        network: tracker.window(stepStart, stepEnd),
        screenshot: screenshotKey,
        assertions: attemptFailure?.assertions ?? lastPassedAssertions(step),
      });

      if (attemptFailure) {
        failedStepId = step.id;
        failure = attemptFailure;
        outcome = "failed";
        break; // subsequent steps are skipped (doc 04 §3)
      }
    }

    // teardown + artifact flush BEFORE assembling the result: video/har/trace only
    // exist on disk once the context closes
    if (context) {
      await context.tracing.stop({ path: tracePath }).catch(() => {});
      const page = context.pages()[0];
      const video = page?.video();
      await context.close();
      context = null;
      const put = async (name: string, fn: () => Promise<string>) => {
        try {
          artifactKeys[name] = await fn();
        } catch (err) {
          logger.warn({ err, name }, "artifact upload failed");
        }
      };
      if (job.collect.video && video) {
        const videoPath = await video.path().catch(() => null);
        if (videoPath) {
          await put("video", () => artifacts.putFile(artifactKey(job, "video.webm"), videoPath, "video/webm"));
        }
      }
      if (job.collect.har) {
        await put("har", () => artifacts.putFile(artifactKey(job, "network.har"), harPath, "application/json"));
      }
      await put("trace", () => artifacts.putFile(artifactKey(job, "trace.zip"), tracePath, "application/zip"));
      await put("console", () =>
        artifacts.putBuffer(artifactKey(job, "console.json"), JSON.stringify(consoleLines, null, 2), "application/json"),
      );
    }

    return finalize(outcome, failedStepId, failure);
  } finally {
    try {
      if (context) await context.close().catch(() => {});
      await browser?.close();
    } finally {
      await rm(workdir, { recursive: true, force: true }).catch(() => {});
    }
  }

  function finalize(
    status: "passed" | "failed" | "error" | "skipped",
    failedStep: string | null,
    fail: StepFailure | null,
  ): RunFlowResult {
    return RunFlowResultSchema.parse({
      runId: job.runId,
      flowId: job.flowId,
      specVersionId: job.specVersionId,
      target: job.target.kind,
      status,
      failedStepId: failedStep,
      failureClass: fail?.failureClass ?? null,
      steps,
      perf: { flowTotalMs: Date.now() - flowStart, regressions: [] },
      artifacts: artifactKeys,
      diagnostics: {
        pendingRequestsAtTimeout: tracker.pendingRequests(),
        consoleErrors: consoleErrors.slice(-20),
        pageCrashed,
        nextErrorOverlay: false, // classifier lands in Phase 7
        blankScreenScore: 0,
      },
    });
  }
}

/** Act + settle + assert. Returns null on success, failure details otherwise. */
async function runStepOnce(
  page: Page,
  baseUrl: string,
  step: FlowStep,
  tracker: NetworkTracker,
  logger: Logger,
): Promise<StepFailure | null> {
  const urlBefore = page.url();
  try {
    await act(page, baseUrl, step);
  } catch (err) {
    if (err instanceof LocatorMissError) {
      return { failureClass: "locator_miss", message: err.message, assertions: [] };
    }
    return {
      failureClass: "env",
      message: err instanceof Error ? err.message.split("\n")[0]! : String(err),
      assertions: [],
    };
  }

  await settle(page, step, urlBefore, logger);

  const results: StepAssertionResult[] = [];
  for (const assertion of step.postConditions) {
    results.push(await evalAssertion(page, assertion));
  }
  const failedAssertion = results.find((r) => !r.pass);
  if (failedAssertion) {
    return {
      failureClass: "assertion",
      message: failedAssertion.message ?? `${failedAssertion.kind} assertion failed`,
      assertions: results,
    };
  }
  return null;
}

async function act(page: Page, baseUrl: string, step: FlowStep): Promise<void> {
  const action = step.action;
  switch (action.type) {
    case "navigate":
      await page.goto(baseUrl + action.path, { waitUntil: "load", timeout: 30000 });
      return;
    case "click":
      await (await resolveLocator(page, action.locators)).click();
      return;
    case "type":
      await (await resolveLocator(page, action.locators)).fill(action.value);
      return;
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
    default:
      throw new Error(`action type "${action.type}" lands in a later phase`);
  }
}

/** Settle strategies networkidle|navigation|timeout (doc 09 Phase 2 scope). */
async function settle(page: Page, step: FlowStep, urlBefore: string, logger: Logger): Promise<void> {
  const { strategy, timeoutMs } = step.settle;
  try {
    switch (strategy) {
      case "navigation": {
        // wait until the URL actually changed, then for the new document to load
        const deadline = Date.now() + timeoutMs;
        while (page.url() === urlBefore && Date.now() < deadline) {
          await page.waitForTimeout(100);
        }
        await page.waitForLoadState("load", { timeout: Math.max(1, deadline - Date.now()) });
        return;
      }
      case "networkidle":
        await page.waitForLoadState("networkidle", { timeout: timeoutMs });
        return;
      case "timeout":
        await page.waitForTimeout(timeoutMs);
        return;
      default:
        // animationQuiescence etc. land in Phase 12; use a bounded networkidle for now
        await page.waitForLoadState("networkidle", { timeout: timeoutMs });
        return;
    }
  } catch {
    // settle timeout is not itself a failure: proceed to post-condition evaluation
    // (doc 04 §3; the hang classifier arrives in Phase 7)
    logger.debug({ step: step.id, strategy }, "settle timed out — evaluating post-conditions anyway");
  }
}

function lastPassedAssertions(step: FlowStep): StepAssertionResult[] {
  return step.postConditions.map((a) => ({ kind: a.kind, pass: true }));
}

async function captureFailureBundle(
  page: Page,
  step: FlowStep,
  artifacts: ArtifactStore,
  job: ExecuteFlowJob,
  tracker: NetworkTracker,
  consoleLines: Array<{ ts: number; text: string }>,
  logger: Logger,
): Promise<string | null> {
  try {
    const shot = await page.screenshot({ timeout: 5000 });
    const key = await artifacts.putBuffer(
      artifactKey(job, `steps/${step.id}/failure.png`),
      shot,
      "image/png",
    );
    const aria = await page
      .locator("body")
      .ariaSnapshot({ timeout: 3000 })
      .catch(() => "unavailable");
    await artifacts.putBuffer(
      artifactKey(job, `steps/${step.id}/failure-bundle.json`),
      JSON.stringify(
        {
          stepId: step.id,
          url: page.url(),
          pendingRequests: tracker.pendingRequests(),
          consoleTail: consoleLines.slice(-20),
          ariaSnapshot: aria,
        },
        null,
        2,
      ),
      "application/json",
    );
    return key;
  } catch (err) {
    logger.warn({ err }, "failure bundle capture failed");
    return null;
  }
}

/**
 * Origin guard + Vercel bypass (doc 04 §2, doc 07 §4.5): bypass headers are
 * attached ONLY to same-host navigation requests; navigations off the deployment
 * host are refused (allowlisted provider frames arrive with payments in Phase 11).
 */
function installOriginGuardAndBypass(page: Page, job: ExecuteFlowJob, logger: Logger): void {
  const depHost = new URL(job.target.deploymentUrl).host;
  void page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const isNav = req.isNavigationRequest() && req.frame() === page.mainFrame();
    if (isNav && url.host !== depHost) {
      logger.warn({ url: url.host }, "blocked off-host navigation (origin guard)");
      await route.abort("blockedbyclient");
      return;
    }
    if (isNav && job.target.bypassSecret) {
      await route.continue({
        headers: {
          ...req.headers(),
          "x-vercel-protection-bypass": job.target.bypassSecret,
          "x-vercel-set-bypass-cookie": "true",
        },
      });
      return;
    }
    await route.continue();
  });
}

/** Vercel's SSO challenge page (we detect it so protection issues are env, not flow, failures). */
async function isProtectionChallenge(page: Page): Promise<boolean> {
  const url = page.url();
  return url.includes("vercel.com/sso-api") || url.includes("_vercel/protection");
}
