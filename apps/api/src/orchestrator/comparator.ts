import type { FlowSpec, RunFlowResult, VerdictKind } from "@flowguard/schemas";

/**
 * Dual-threshold perf gate with mandatory attribution (doc 04 §4): flag only if
 * `head > base × relativeFactor` AND `head − base > absoluteFloorMs`, and only
 * when the delta can be attributed to a network request or client time. An
 * unattributed delta is suppressed — false positives are death.
 */
export interface PerfFinding {
  stepId: string;
  stepTitle: string;
  baseMs: number;
  headMs: number;
  attribution:
    | { kind: "network"; request: string; baseTtfb: number; headTtfb: number }
    | { kind: "client"; settleDelta: number };
}

export function computePerfRegressions(
  spec: FlowSpec,
  head: RunFlowResult,
  base: RunFlowResult,
): PerfFinding[] {
  const { relativeFactor, absoluteFloorMs } = spec.budgets.perStepDefaults;
  const findings: PerfFinding[] = [];
  for (const headStep of head.steps) {
    const baseStep = base.steps.find((s) => s.id === headStep.id);
    const stepSpec = spec.steps.find((s) => s.id === headStep.id);
    if (!baseStep || !stepSpec?.timingBaselineKey) continue;
    const delta = headStep.durationMs - baseStep.durationMs;
    if (!(headStep.durationMs > baseStep.durationMs * relativeFactor && delta > absoluteFloorMs)) continue;

    // attribution: which request's server time exploded?
    let best: { request: string; baseTtfb: number; headTtfb: number; growth: number } | null = null;
    for (const headReq of headStep.network) {
      if (!["fetch", "xhr", "document"].includes(headReq.resourceType)) continue;
      const headPath = pathOf(headReq.url);
      const baseReq = baseStep.network.find(
        (b) => b.method === headReq.method && pathOf(b.url) === headPath,
      );
      if (!baseReq) continue;
      const growth = headReq.ttfbMs - baseReq.ttfbMs;
      if (growth > 0 && (!best || growth > best.growth)) {
        best = {
          request: `${headReq.method} ${headPath}`,
          baseTtfb: baseReq.ttfbMs,
          headTtfb: headReq.ttfbMs,
          growth,
        };
      }
    }
    if (best && best.growth >= delta * 0.4) {
      findings.push({
        stepId: headStep.id,
        stepTitle: stepSpec.title,
        baseMs: baseStep.durationMs,
        headMs: headStep.durationMs,
        attribution: {
          kind: "network",
          request: best.request,
          baseTtfb: best.baseTtfb,
          headTtfb: best.headTtfb,
        },
      });
      continue;
    }
    const settleDelta = headStep.settleMs - baseStep.settleMs;
    if (settleDelta >= delta * 0.4) {
      findings.push({
        stepId: headStep.id,
        stepTitle: stepSpec.title,
        baseMs: baseStep.durationMs,
        headMs: headStep.durationMs,
        attribution: { kind: "client", settleDelta },
      });
      continue;
    }
    // unattributed → suppressed (doc 04 §4)
  }
  return findings;
}

function pathOf(url: string): string {
  try {
    return new URL(url, "http://x").pathname;
  } catch {
    return url;
  }
}

export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/**
 * Pre-LLM comparator (doc 09 Phase 3 task 3; taxonomy doc 05 §1):
 *   head pass                       → ✅ passing
 *   head env-class                  → 🟣 env_issue (never blame the flow for the world)
 *   head fail + base pass           → 🔴 broken
 *   head fail + base fail           → ⬜ already_broken_on_base
 *   head fail + base unavailable    → 🟣 env_issue ("couldn't verify against base" —
 *                                       false positives are death, doc CLAUDE.md §3)
 * The intent-aware judge (🔵) replaces the 🔴 path in Phase 9.
 */

const ENV_FAILURE_CLASSES = new Set(["env", "login_failed", "payment_unverified_env"]);

export interface FlowComparison {
  verdict: VerdictKind;
  detail: string;
}

export interface ArtifactLinker {
  (s3Key: string, label: string): string;
}

export function compareFlow(params: {
  spec: FlowSpec;
  head: RunFlowResult;
  base: RunFlowResult | null;
  baseAvailable: boolean;
  link: ArtifactLinker;
  /** Dashboard URL for entering PR-scoped credentials (login_failed copy). */
  credentialsUrl?: string;
  /** For the webhook-attribution rule (doc 05 §3.5); absent = diff unknown. */
  changedFiles?: string[];
}): FlowComparison {
  const { spec, head, base, baseAvailable, link } = params;

  if (head.status === "passed") {
    const secs = (head.perf.flowTotalMs / 1000).toFixed(1);
    // healed pass (doc 04 §5): green, but the selector drift is surfaced
    if (head.healAttempt.succeeded) {
      return {
        verdict: "passing",
        detail: `${secs}s — step succeeded via adaptive retry; selector likely changed (spec-drift proposal in dashboard)`,
      };
    }
    // perf gate — only when a base measurement exists to compare against
    if (base && base.status === "passed") {
      const regressions = computePerfRegressions(spec, head, base);
      if (regressions.length > 0) {
        const worst = regressions.reduce((a, b) => (b.headMs - b.baseMs > a.headMs - a.baseMs ? b : a));
        const attribution =
          worst.attribution.kind === "network"
            ? `\`${worst.attribution.request}\` TTFB ${formatMs(worst.attribution.baseTtfb)}→${formatMs(worst.attribution.headTtfb)}`
            : `client time (+${formatMs(worst.attribution.settleDelta)} settle)`;
        return {
          verdict: "slower",
          detail: `step ${worst.stepId} "${worst.stepTitle}": ${formatMs(worst.baseMs)} → ${formatMs(worst.headMs)} — ${attribution}`,
        };
      }
    }
    return { verdict: "passing", detail: `${secs}s` };
  }

  // an aborted (superseded) run's flows report "skipped" — never blame the PR
  // for a run we cancelled ourselves (belt-and-braces; the orchestrator should
  // not report superseded runs at all)
  if (head.status === "skipped") {
    return {
      verdict: "env_issue",
      detail: "run was superseded before this flow completed — see the latest push's results",
    };
  }

  if (head.status === "error" || (head.failureClass && ENV_FAILURE_CLASSES.has(head.failureClass))) {
    return {
      verdict: "env_issue",
      detail: envCopy(head, params.credentialsUrl),
    };
  }

  // head genuinely failed/hung/died at a step
  const failureDetail = describeFailure(spec, head, link);

  // webhook attribution (doc 05 §3.5): the purchase visibly succeeded, the
  // caveatted state assertion failed, and the diff didn't touch purchase code
  // → 🟣, never 🔴. This happens CONSTANTLY with buy-then-use flows on
  // previews — correct attribution here is a trust cornerstone.
  const failedStep = spec.steps.find((s) => s.id === head.failedStepId);
  if (
    failedStep?.caveats?.includes("webhook_dependent") &&
    head.failureClass === "assertion" &&
    paymentVisiblySucceeded(spec, head) &&
    !diffTouchesPurchaseCode(params.changedFiles)
  ) {
    return {
      verdict: "env_issue",
      detail: `purchase completed but app state never updated — commonly a payment webhook not configured for preview URLs · ${failureDetail}`,
    };
  }

  // the honesty rule (doc 04 §4): blaming the PR requires base-side green
  if (base && base.status !== "passed" && base.status !== "error") {
    return {
      verdict: "already_broken_on_base",
      detail: `same flow fails on base — not caused by this PR · ${failureDetail}`,
    };
  }
  if (!baseAvailable || !base || base.status === "error") {
    return {
      verdict: "env_issue",
      detail: `flow failed on head but base comparison was unavailable — review manually · ${failureDetail}`,
    };
  }
  if (head.status === "hung") return { verdict: "hung", detail: failureDetail };
  if (head.status === "dead") return { verdict: "dead", detail: failureDetail };
  return { verdict: "broken", detail: failureDetail };
}

/** The payment step ran and the flow progressed past it (success redirect). */
function paymentVisiblySucceeded(spec: FlowSpec, head: RunFlowResult): boolean {
  const paymentStep = spec.steps.find((s) => s.action.type === "payment");
  if (!paymentStep) return false;
  const executed = head.steps.some((s) => s.id === paymentStep.id);
  return executed && head.failedStepId !== paymentStep.id;
}

function diffTouchesPurchaseCode(changedFiles?: string[]): boolean {
  if (!changedFiles) return false; // diff unknown (validation runs) — rule still applies
  return changedFiles.some((f) =>
    /(pay|stripe|checkout|billing|purchase|buy|webhook|confirm|order|invoice)/i.test(f),
  );
}

function envCopy(head: RunFlowResult, credentialsUrl?: string): string {
  if (head.failureClass === "login_failed") {
    const fix = credentialsUrl
      ? ` — provide [PR-scoped credentials](${credentialsUrl}), then comment \`/flowguard rerun\``
      : " — check the project credentials, then comment `/flowguard rerun`";
    return `login failed on this preview: credentials may be wrong, or this PR may use a separate database${fix}`;
  }
  if (head.failureClass === "payment_unverified_env") {
    return "payment step skipped — could not verify test mode on this preview";
  }
  return "deployment unreachable or environment problem — not a flow failure";
}

/** Failure rows always name the exact step and cause (doc 05 §6). */
export function describeFailure(spec: FlowSpec, head: RunFlowResult, link: ArtifactLinker): string {
  const stepSpec = spec.steps.find((s) => s.id === head.failedStepId);
  const stepResult = head.steps.find((s) => s.id === head.failedStepId);
  const title = stepSpec ? `step ${stepSpec.id} "${stepSpec.title}"` : `step ${head.failedStepId ?? "?"}`;

  const parts: string[] = [];
  if (head.failureClass === "locator_miss") {
    parts.push(`${title}: element not found (all locators missed)`);
  } else if (head.status === "dead") {
    parts.push(`page died at ${title}: ${head.diagnostics.failureDetail ?? "crash"}`);
  } else {
    const failedAssertion = stepResult?.assertions.find((a) => !a.pass);
    parts.push(`stuck at ${title}: ${failedAssertion?.message ?? head.failureClass ?? "failed"}`);
  }

  const serverErrors = (stepResult?.network ?? []).filter((n) => n.status >= 500 || n.status === 0);
  if (serverErrors.length > 0) {
    const e = serverErrors[0]!;
    parts.push(`\`${e.method} ${new URL(e.url, "http://x").pathname}\` → ${e.status || "failed"}`);
  }
  const pending = head.diagnostics.pendingRequestsAtTimeout;
  if (pending.length > 0) {
    const p = pending[0]!;
    parts.push(`\`${p.method} ${new URL(p.url, "http://x").pathname}\` pending ${(p.pendingMs / 1000).toFixed(0)}s`);
  }

  const links: string[] = [];
  if (head.artifacts.video) links.push(link(head.artifacts.video, "video"));
  if (head.artifacts.trace) links.push(link(head.artifacts.trace, "trace"));
  if (stepResult?.screenshot) links.push(link(stepResult.screenshot, "screenshot"));
  if (links.length) parts.push(links.join(" "));

  return parts.join(" · ");
}
