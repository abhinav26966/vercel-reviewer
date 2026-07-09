import type { FlowSpec, RunFlowResult, VerdictKind } from "@flowguard/schemas";

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
}): FlowComparison {
  const { spec, head, base, baseAvailable, link } = params;

  if (head.status === "passed") {
    const secs = (head.perf.flowTotalMs / 1000).toFixed(1);
    return { verdict: "passing", detail: `${secs}s` };
  }

  if (head.status === "error" || (head.failureClass && ENV_FAILURE_CLASSES.has(head.failureClass))) {
    return {
      verdict: "env_issue",
      detail: envCopy(head, params.credentialsUrl),
    };
  }

  // head genuinely failed a step
  const failureDetail = describeFailure(spec, head, link);

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
  return { verdict: "broken", detail: failureDetail };
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
