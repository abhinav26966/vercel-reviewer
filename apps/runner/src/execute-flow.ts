import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import type { Logger } from "pino";
import type { InferenceProvider } from "@flowguard/inference";
import { RunFlowResultSchema } from "@flowguard/schemas";
import { globalRedaction } from "@flowguard/shared";
import { artifactKey, type ArtifactStore } from "./artifacts.js";
import { redactHarFile } from "./har-redact.js";
import { NetworkTracker } from "./network-tracker.js";
import { specUsesSecrets, type SecretResolver } from "./secrets.js";
import { ensureStorageState, LoginFailedError } from "./session.js";
import { blankScreenScore, classifyFailure, detectNextErrorOverlay } from "./classify.js";
import { collectCoverage, startCoverage } from "./coverage.js";
import { healStep } from "./heal.js";
import { STRIPE_FRAME_ALLOWLIST } from "./payments/stripe.js";
import { gotoWithRetry, runStepOnce, type SecretLookup, type StepFailure } from "./steps.js";
import type { ExecuteFlowJob, FlowStep, RunFlowResult, StepAssertionResult, StepResult } from "./types.js";

export interface ExecuteFlowOptions {
  job: ExecuteFlowJob;
  logger: Logger;
  artifacts: ArtifactStore;
  /** Resolves sec_* references; required for personas / secret placeholders. */
  secretResolver?: SecretResolver;
  /** Checked between steps (doc 01 §6 cancellation). */
  shouldAbort?: () => Promise<boolean>;
  headless?: boolean;
  databaseUrl?: string;
  /** Heal/explore agent backend (doc 04 §5); absent ⇒ heal silently skipped. */
  inference?: InferenceProvider;
}

/**
 * Deterministic replay loop (doc 04 §§2–3): session injection → context setup →
 * bypass → per step act/settle/assert with one deterministic retry → failure
 * bundle → redacted artifacts.
 */
export async function executeFlow(opts: ExecuteFlowOptions): Promise<RunFlowResult> {
  const { job, logger, artifacts } = opts;
  const spec = job.spec;
  const workdir = await mkdtemp(path.join(tmpdir(), "flowguard-run-"));
  const harPath = path.join(workdir, "network.har");
  const tracePath = path.join(workdir, "trace.zip");
  const specHasPayment = spec.steps.some((s) => s.action.type === "payment");
  // secret-typing AND payment specs skip tracing: trace action/network capture
  // can embed request bodies and card fills (doc 07 §4.3, §6)
  const collectTrace = !specUsesSecrets(spec) && !specHasPayment;

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
  let outcome: "passed" | "failed" | "error" | "skipped" | "hung" | "dead" = "passed";
  let failureDetail: string | null = null;
  let nextErrorOverlay = false;
  let blankScore = 0;
  let failureClassOverride: string | null = null;
  let coverage: RunFlowResult["coverage"] = null;
  let healAttempted = false;
  let healsSucceeded = 0;
  let healsFailed = 0;
  const healPatches: Array<{ stepId: string; locators: unknown[] }> = [];
  const healTranscript: string[] = [];
  const flowStart = Date.now();
  const tracker = new NetworkTracker();

  const lookupSecret: SecretLookup = async (placeholder) => {
    const ref = job.configBundle.secretRefs[placeholder];
    if (!ref) throw new Error(`no secret resolved for placeholder "${placeholder}" on this target`);
    if (!opts.secretResolver) throw new Error("no secret resolver configured");
    return opts.secretResolver.resolve(ref);
  };

  try {
    browser = await chromium.launch({
      headless: opts.headless ?? true,
      // software WebGL so canvas flows render identically everywhere (doc 04 §2)
      args: ["--use-angle=swiftshader"],
    });

    // ── session: log in once per (persona, deployment), inject storageState ──
    let storageStatePath: string | null = null;
    if (job.configBundle.persona) {
      try {
        storageStatePath = await ensureStorageState(
          {
            browser,
            artifacts,
            logger,
            lookupSecret,
            ...(opts.databaseUrl !== undefined ? { databaseUrl: opts.databaseUrl } : {}),
          },
          job,
        );
      } catch (err) {
        const detail = err instanceof LoginFailedError ? err.detail : String(err);
        logger.error({ persona: job.configBundle.persona.name, detail }, "login failed for persona");
        outcome = "error";
        failure = { failureClass: "env", message: `login failed: ${detail}`, assertions: [] };
      }
    }

    context = await browser.newContext({
      viewport: { width: spec.viewport.width, height: spec.viewport.height },
      deviceScaleFactor: spec.viewport.dpr,
      recordVideo: job.collect.video ? { dir: workdir } : undefined,
      recordHar: job.collect.har ? { path: harPath, content: "omit" } : undefined,
      ...(storageStatePath ? { storageState: storageStatePath } : {}),
    });
    if (collectTrace) {
      await context.tracing.start({ screenshots: true, snapshots: true });
    }

    const page = await context.newPage();
    tracker.attach(page);
    let coverageStarted = false;
    if (job.collect.coverage) {
      coverageStarted = await startCoverage(page, logger);
    }
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

    const baseUrl = job.target.deploymentUrl.replace(/\/$/, "");
    if (outcome === "passed") {
      try {
        await gotoWithRetry(page, baseUrl + spec.startPath, logger);
      } catch (err) {
        logger.error({ err }, "initial navigation failed");
        outcome = "error";
        failure = {
          failureClass: "env",
          message: `deployment unreachable: ${err instanceof Error ? err.message.split("\n")[0] : err}`,
          assertions: [],
        };
      }
    }
    if (outcome === "passed" && (await isProtectionChallenge(page))) {
      outcome = "error";
      failure = {
        failureClass: "env",
        message: "Vercel deployment protection challenge — bypass secret missing or rejected",
        assertions: [],
      };
    }

    const stepCtx = {
      page,
      baseUrl,
      tracker,
      logger,
      lookupSecret,
      payment: job.configBundle.payment
        ? {
            provider: job.configBundle.payment.provider,
            cardRef: job.configBundle.payment.cardRef,
            expiry: job.configBundle.payment.expiry,
            cvcRef: job.configBundle.payment.cvcRef,
          }
        : null,
      ...(opts.secretResolver ? { resolveRef: (ref: string) => opts.secretResolver!.resolve(ref) } : {}),
    };
    for (const step of outcome === "passed" ? spec.steps : []) {
      if (opts.shouldAbort && (await opts.shouldAbort())) {
        logger.info({ step: step.id }, "abort requested — stopping between steps");
        outcome = "skipped";
        break;
      }

      const stepStart = Date.now();
      const pageErrorsBefore = consoleErrors.filter((e) => e.text.startsWith("pageerror:")).length;
      let attempt = await runStepOnce(stepCtx, step);
      if (attempt.failure) {
        // one deterministic retry: page may have been mid-hydration (doc 04 §3)
        logger.warn({ step: step.id, reason: attempt.failure.message }, "step failed — deterministic retry");
        attempt = await runStepOnce(stepCtx, step);
      }
      // bounded agentic heal (doc 04 §5) — never for env/guard failures, never
      // for secret or payment steps (fail closed), explore mode heals every step
      if (
        attempt.failure &&
        attempt.failure.failureClass !== "env" &&
        attempt.failure.failureClass !== "payment_unverified_env" &&
        step.action.type !== "payment" &&
        opts.inference &&
        (job.agentHeal || job.mode === "explore")
      ) {
        healAttempted = true;
        const heal = await healStep(stepCtx, step, opts.inference, logger);
        healTranscript.push(...heal.transcript.map((t) => `[${step.id}] ${t}`));
        if (heal.succeeded) {
          healsSucceeded++;
          if (heal.proposedPatch) healPatches.push(heal.proposedPatch);
          attempt = { failure: null, settleMs: attempt.settleMs, settleTimedOut: false };
        } else {
          healsFailed++;
        }
      }
      const stepEnd = Date.now();
      const stepNetwork = tracker.window(stepStart, stepEnd);

      let screenshotKey: string | null = null;
      if (attempt.failure) {
        // classify BEFORE the bundle capture so the score comes from the same shot
        const shot = await page.screenshot({ timeout: 5000 }).catch(() => null);
        blankScore = shot ? blankScreenScore(shot) : 0;
        nextErrorOverlay = await detectNextErrorOverlay(page);
        screenshotKey = await captureFailureBundle(page, step, artifacts, job, tracker, consoleLines, logger, shot);
      }

      steps.push({
        id: step.id,
        durationMs: stepEnd - stepStart,
        settleMs: attempt.settleMs,
        network: stepNetwork,
        screenshot: screenshotKey,
        assertions: attempt.failure?.assertions ?? lastPassedAssertions(step),
      });

      if (attempt.failure) {
        failedStepId = step.id;
        failure = attempt.failure;
        // the slow/hung/dead spectrum (doc 04 §4). A dead page usually surfaces
        // as a missed locator, so dead signals override ANY failure class; the
        // hung signals only make sense when post-conditions were being awaited.
        const pageErrorsNow = consoleErrors.filter((e) => e.text.startsWith("pageerror:")).length;
        const cls = classifyFailure({
          settleTimedOut: attempt.settleTimedOut,
          pendingRequests: tracker.pendingRequests(),
          stepNetwork,
          pageCrashed,
          pageErrors: pageErrorsNow - pageErrorsBefore,
          nextErrorOverlay,
          blankScreenScore: blankScore,
        });
        // env-class failures stay env: a half-loaded/mid-redirect page LOOKS
        // blank, and "deployment unreachable" must never become "your app died"
        const envClass = attempt.failure.failureClass === "env" || attempt.failure.failureClass === "payment_unverified_env";
        if (!envClass && (attempt.failure.failureClass === "assertion" || cls.status === "dead")) {
          outcome = cls.status;
          failureClassOverride = cls.failureClass;
          failureDetail = cls.detail;
          if (cls.detail) {
            failure = { ...failure, message: `${failure.message} · ${cls.detail}` };
          }
        } else {
          outcome = "failed";
          // surface the specific payment env message in the verdict (doc 07 §6/§7)
          if (attempt.failure.failureClass === "payment_unverified_env") {
            failureDetail = attempt.failure.message;
          }
        }
        break; // subsequent steps are skipped (doc 04 §3)
      }
    }

    // teardown + artifact flush BEFORE assembling the result; every text artifact
    // passes the redaction registry (doc 07 §4.3)
    if (context) {
      if (collectTrace) await context.tracing.stop({ path: tracePath }).catch(() => {});
      const page2 = context.pages()[0];
      const video = page2?.video();
      if (coverageStarted && page2) {
        coverage = await collectCoverage(
          page2,
          tracker.window(0, Date.now()),
          job.target.deploymentUrl,
          logger,
          job.target.bypassSecret,
        ).catch(() => null);
      }
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
        await redactHarFile(harPath, globalRedaction);
        await put("har", () => artifacts.putFile(artifactKey(job, "network.har"), harPath, "application/json"));
      }
      if (collectTrace) {
        await put("trace", () => artifacts.putFile(artifactKey(job, "trace.zip"), tracePath, "application/zip"));
      }
      await put("console", () =>
        artifacts.putBuffer(
          artifactKey(job, "console.json"),
          globalRedaction.redactString(JSON.stringify(consoleLines, null, 2)),
          "application/json",
        ),
      );
      if (coverage) {
        const cov = coverage;
        await put("coverage", () =>
          artifacts.putBuffer(artifactKey(job, "coverage.json"), JSON.stringify(cov, null, 2), "application/json"),
        );
      }
    }

    return finalize(outcome, failedStepId, failure);
  } finally {
    try {
      if (context) await (context as BrowserContext).close().catch(() => {});
      await browser?.close();
    } finally {
      await rm(workdir, { recursive: true, force: true }).catch(() => {});
    }
  }

  function finalize(
    status: "passed" | "failed" | "error" | "skipped" | "hung" | "dead",
    failedStep: string | null,
    fail: StepFailure | null,
  ): RunFlowResult {
    return RunFlowResultSchema.parse(
      globalRedaction.redactDeep({
        runId: job.runId,
        flowId: job.flowId,
        specVersionId: job.specVersionId,
        target: job.target.kind,
        status,
        failedStepId: failedStep,
        failureClass:
          status === "error" && fail?.message.startsWith("login failed")
            ? "login_failed"
            : (failureClassOverride ?? fail?.failureClass ?? null),
        healAttempt: {
          attempted: healAttempted,
          succeeded: healsSucceeded > 0 && healsFailed === 0,
          proposedPatch:
            healPatches.length === 0 ? null : healPatches.length === 1 ? healPatches[0] : healPatches,
        },
        steps,
        perf: { flowTotalMs: Date.now() - flowStart, regressions: [] },
        artifacts: artifactKeys,
        diagnostics: {
          pendingRequestsAtTimeout: tracker.pendingRequests(),
          consoleErrors: consoleErrors.slice(-20),
          pageCrashed,
          nextErrorOverlay,
          blankScreenScore: blankScore,
          failureDetail,
          healTranscript,
        },
        coverage,
      }),
    );
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
  existingShot?: Buffer | null,
): Promise<string | null> {
  try {
    const shot = existingShot ?? (await page.screenshot({ timeout: 5000 }));
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
      globalRedaction.redactString(
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
 * host are refused — EXCEPT allowlisted payment-provider hosts when the spec
 * carries a payment step (doc 07 §6).
 */
function installOriginGuardAndBypass(page: Page, job: ExecuteFlowJob, logger: Logger): void {
  const depHost = new URL(job.target.deploymentUrl).host;
  const providerHosts = job.spec.steps.some((s) => s.action.type === "payment")
    ? STRIPE_FRAME_ALLOWLIST
    : [];
  const allowed = (host: string) =>
    host === depHost || providerHosts.some((h) => host === h || host.endsWith(`.${h}`));
  void page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const isNav = req.isNavigationRequest() && req.frame() === page.mainFrame();
    if (isNav && !allowed(url.host)) {
      logger.warn({ url: url.host }, "blocked off-host navigation (origin guard)");
      await route.abort("blockedbyclient");
      return;
    }
    if (isNav && url.host !== depHost) {
      // provider host: pass through untouched (no bypass headers off-host)
      await route.continue();
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

/** Vercel's SSO challenge page (protection issues are env, not flow, failures). */
async function isProtectionChallenge(page: Page): Promise<boolean> {
  const url = page.url();
  return url.includes("vercel.com/sso-api") || url.includes("_vercel/protection");
}
