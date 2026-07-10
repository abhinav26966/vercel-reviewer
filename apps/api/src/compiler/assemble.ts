import { FlowSpecSchema, type FlowSpec, type Locator, type RecordingTrace } from "@flowguard/schemas";
import type { NormalizedEvent } from "./normalize.js";
import type { LoginDetection } from "./detect.js";
import type { StepSuggestion } from "./vision-pass.js";

/**
 * Stage 6/7 — delta rewriting + draft assembly (doc 03 B2.6–7).
 * Steps are built FROM trace events by code; the model only contributes titles,
 * intents, and assertion suggestions. Hallucination guard (doc 03 B4): every
 * step references ≥1 source event id, and suggested locators must exist in the
 * captured DOM outlines or the suggestion is demoted to needsAttention.
 */

export interface AssembleInput {
  trace: RecordingTrace;
  events: NormalizedEvent[];
  login: LoginDetection | null;
  suggestions: Map<string, StepSuggestion>;
  flowMeta: { name: string; description: string } | null;
  /** user-chosen name wins over the model's (doc 03 B2.4) */
  recordedFlowName: string | null;
  projectId: string;
  flowId: string;
  /** all data-testids seen in captured DOM outlines (hallucination guard) */
  knownTestIds: Set<string>;
  dropped: Array<{ id: string; reason: string }>;
  /** Event ids inside payment-provider context (doc 03 B5) → ONE typed payment step. */
  paymentEventIds?: Set<string>;
  /** false ⇒ the payment step is flagged needsAttention (consent gate, doc 07 §6). */
  hasPaymentConfig?: boolean;
}

export interface CompilationReport {
  stepSourceEvents: Record<string, string[]>;
  droppedEvents: Array<{ id: string; reason: string }>;
  loginReplacement: { replacedEventIds: string[]; persona: string } | null;
  needsAttention: Array<{ stepId: string | null; message: string }>;
  rejectedSuggestions: Array<{ stepId: string; reason: string; suggestion: unknown }>;
  visionFailures: string[];
}

export interface AssembleResult {
  spec: FlowSpec;
  report: CompilationReport;
}

export function assembleSpec(input: AssembleInput): AssembleResult {
  const report: CompilationReport = {
    stepSourceEvents: {},
    droppedEvents: [...input.dropped],
    loginReplacement: input.login
      ? { replacedEventIds: input.login.replacedEventIds, persona: input.login.persona }
      : null,
    needsAttention: [],
    rejectedSuggestions: [],
    visionFailures: [],
  };

  const flowEvents = input.login ? input.events.slice(input.login.resumeIndex) : input.events;
  if (flowEvents.length === 0) throw new Error("no events remain after login extraction");

  // startPath: where the flow begins after login (first event's page)
  const firstEvent = flowEvents[0]!.event;
  const startPath = new URL(firstEvent.url).pathname || "/";

  const steps: FlowSpec["steps"] = [];
  let stepSeq = 0;

  const consumedNavigations = new Set<string>();
  let paymentStepEmitted = false;
  for (let i = 0; i < flowEvents.length; i++) {
    const ne = flowEvents[i]!;
    const ev = ne.event;

    // payment context (doc 03 B5): the whole provider click-sequence becomes
    // ONE typed step — recorded iframe internals are opaque and unneeded
    if (input.paymentEventIds?.has(ev.id)) {
      if (!paymentStepEmitted) {
        paymentStepEmitted = true;
        const stepId = `s${++stepSeq}`;
        steps.push({
          id: stepId,
          title: "Complete payment (Stripe test mode)",
          action: { type: "payment", provider: "stripe", variant: "card", configRef: "project" },
          settle: { strategy: "navigation", timeoutMs: 30000 },
          postConditions: [],
          timingBaselineKey: stepId,
        });
        report.stepSourceEvents[stepId] = [...input.paymentEventIds];
        if (!input.hasPaymentConfig) {
          report.needsAttention.push({
            stepId,
            message:
              "payment step requires a payment config — configure payments for this project (consent gate, doc 07 §6)",
          });
        }
      }
      continue;
    }
    // steps after a payment step asserting server state may depend on webhooks
    if (ev.type === "navigation") {
      if (consumedNavigations.has(ev.id)) continue;
      if (i === 0) continue; // covered by startPath
      if (ne.consequenceOf) continue; // consequence of the previous step's settle
      const stepId = `s${++stepSeq}`;
      steps.push({
        id: stepId,
        title: `Go to ${new URL(ev.url).pathname}`,
        action: { type: "navigate", path: new URL(ev.url).pathname + new URL(ev.url).search },
        settle: { strategy: "networkidle", timeoutMs: 8000 },
        postConditions: [],
        timingBaselineKey: stepId,
      });
      report.stepSourceEvents[stepId] = [ev.id];
      continue;
    }
    if (!ev.target) continue;

    const stepId = `s${++stepSeq}`;
    const suggestion = input.suggestions.get(ev.id);
    const causedNav = flowEvents.find((o) => o.consequenceOf === ev.id);
    if (causedNav) consumedNavigations.add(causedNav.event.id);

    const action = buildAction(ev, suggestion, report, stepId);
    if (!action) {
      report.droppedEvents.push({ id: ev.id, reason: `unsupported event type ${ev.type}` });
      stepSeq--;
      continue;
    }

    const settle = buildSettle(ev, Boolean(causedNav), suggestion);
    const postConditions = buildAssertions(ev, suggestion, causedNav?.event ?? null, input.knownTestIds, report, stepId);

    steps.push({
      id: stepId,
      title: suggestion?.title ?? defaultTitle(ev),
      ...(suggestion?.intent ? { intent: suggestion.intent } : {}),
      action,
      settle,
      postConditions,
      // server-state assertions after a payment may hinge on provider webhooks
      // reaching the preview (doc 05 §3.5) — mark them for the comparator
      ...(paymentStepEmitted && postConditions.some((a) => a.kind === "dom" || a.kind === "state")
        ? { caveats: ["webhook_dependent" as const] }
        : {}),
      timingBaselineKey: stepId,
    });
    report.stepSourceEvents[stepId] = [ev.id, ...(causedNav ? [causedNav.event.id] : [])];
  }

  if (steps.length === 0) throw new Error("compilation produced no steps");

  // hallucination guard (doc 03 B4): every step must reference ≥1 source event
  for (const step of steps) {
    const sources = report.stepSourceEvents[step.id] ?? [];
    if (sources.length === 0) throw new Error(`hallucination guard: step ${step.id} has no source events`);
  }

  const spec = FlowSpecSchema.parse({
    specVersion: 3,
    flowId: input.flowId,
    projectId: input.projectId,
    name: input.recordedFlowName ?? input.flowMeta?.name ?? "Recorded flow",
    description: input.flowMeta?.description,
    tier: "standard",
    persona: input.login?.persona ?? null,
    startPath,
    viewport: input.trace.viewport,
    env: {},
    steps,
  });
  return { spec, report };
}

function defaultTitle(ev: NormalizedEvent["event"]): string {
  const name =
    ev.target?.a11y?.name ||
    ev.target?.locators.find((l) => l.kind === "testid")?.value ||
    ev.target?.tag ||
    "element";
  const label = typeof name === "string" ? name : JSON.stringify(name);
  switch (ev.type) {
    case "click":
    case "dblclick":
      return `Click ${label}`.slice(0, 80);
    case "input":
      return `Type into ${label}`.slice(0, 80);
    case "select":
      return `Select in ${label}`.slice(0, 80);
    case "keypress":
      return `Press ${ev.value}`;
    default:
      return `${ev.type} ${label}`.slice(0, 80);
  }
}

function buildAction(
  ev: NormalizedEvent["event"],
  suggestion: StepSuggestion | undefined,
  report: CompilationReport,
  stepId: string,
): FlowSpec["steps"][number]["action"] | null {
  const target = ev.target!;
  const locators = hardenLocators(target.locators, report, stepId);

  if (target.isCanvas && (ev.type === "click" || ev.type === "dblclick")) {
    return {
      type: "canvasClick",
      canvasLocator: locators.filter((l) => l.kind === "testid" || l.kind === "css"),
      point: target.canvasRelative,
      ...(suggestion?.canvasTargetDescription
        ? { visionFallback: { describe: suggestion.canvasTargetDescription } }
        : {}),
    };
  }
  switch (ev.type) {
    case "click":
      return { type: "click", locators };
    case "dblclick":
      return { type: "click", locators }; // dblclick replay lands with a real use case
    case "input": {
      const value = ev.value ?? "";
      if (value.startsWith("«redacted:")) {
        report.needsAttention.push({
          stepId,
          message:
            "typed value was a secret outside the login flow — replace with a {{secret:persona.field}} placeholder",
        });
      }
      return { type: "type", locators, value };
    }
    case "select":
      return { type: "select", locators, value: ev.value ?? "" };
    case "keypress":
      return { type: "press", key: ev.value ?? "Enter", locators };
    default:
      return null;
  }
}

/** Stage 2 — locator hardening (doc 03 B2.2): order by strength, require ≥2. */
function hardenLocators(locators: Locator[], report: CompilationReport, stepId: string): Locator[] {
  const strength: Record<Locator["kind"], number> = {
    testid: 5,
    role: 4,
    label: 3,
    placeholder: 3,
    text: 2,
    css: 1,
  };
  const ordered = [...locators].sort((a, b) => strength[b.kind] - strength[a.kind]);
  const nonCss = ordered.filter((l) => l.kind !== "css");
  if (nonCss.length === 0) {
    report.needsAttention.push({
      stepId,
      message: "only a CSS locator was captured — add a data-testid here for reliability",
    });
  }
  if (ordered.length < 2 && ordered[0]) {
    // schema requires ≥2 for DOM actions; duplicate as an explicit css fallback
    ordered.push({ kind: "css", value: `[data-testid]` });
    report.needsAttention.push({ stepId, message: "fewer than 2 locators captured for this step" });
  }
  return ordered;
}

function buildSettle(
  ev: NormalizedEvent["event"],
  causedNavigation: boolean,
  suggestion: StepSuggestion | undefined,
): FlowSpec["steps"][number]["settle"] {
  if (causedNavigation) return { strategy: "navigation", timeoutMs: 15000 };
  if (ev.target?.isCanvas || suggestion?.settle === "animationQuiescence") {
    return {
      strategy: "animationQuiescence",
      timeoutMs: 15000,
      quiescence: { sampleEveryMs: 500, stableFrames: 3, diffThresholdPct: 1.5 },
    };
  }
  if (ev.type === "input" || ev.type === "select") return { strategy: "timeout", timeoutMs: 300 };
  return { strategy: "networkidle", timeoutMs: 8000 };
}

function buildAssertions(
  ev: NormalizedEvent["event"],
  suggestion: StepSuggestion | undefined,
  causedNav: NormalizedEvent["event"] | null,
  knownTestIds: Set<string>,
  report: CompilationReport,
  stepId: string,
): FlowSpec["steps"][number]["postConditions"] {
  const assertions: FlowSpec["steps"][number]["postConditions"] = [];

  // deterministic, code-derived assertion: navigation destination (belt + braces)
  if (causedNav) {
    const path = new URL(causedNav.url).pathname;
    assertions.push({ kind: "url", assert: "pathMatches", value: `^${escapeRegex(path)}$` });
  }

  for (const s of suggestion?.suggestedAssertions ?? []) {
    // hallucination guard: suggested testids must exist in captured DOM outlines
    if (s.testid && !knownTestIds.has(s.testid)) {
      report.rejectedSuggestions.push({
        stepId,
        reason: `suggested testid "${s.testid}" not present in any captured DOM snapshot`,
        suggestion: s,
      });
      continue;
    }
    switch (s.kind) {
      case "dom-visible":
        if (!s.testid) break;
        assertions.push({
          kind: "dom",
          assert: "visible",
          locators: [
            { kind: "testid", value: s.testid },
            { kind: "css", value: `[data-testid="${s.testid}"]` },
          ],
          ...(s.description ? { description: s.description } : {}),
        });
        break;
      case "dom-text":
        if (!s.testid || s.expected === undefined) break;
        assertions.push({
          kind: "dom",
          assert: "textMatches",
          locators: [
            { kind: "testid", value: s.testid },
            { kind: "css", value: `[data-testid="${s.testid}"]` },
          ],
          value: String(s.expected),
          ...(s.description ? { description: s.description } : {}),
        });
        break;
      case "url-path": {
        const pattern = s.pathRegex ?? (causedNav ? `^${escapeRegex(new URL(causedNav.url).pathname)}$` : null);
        if (!pattern) break;
        if (!assertions.some((a) => a.kind === "url")) {
          assertions.push({ kind: "url", assert: "pathMatches", value: pattern });
        }
        break;
      }
      case "delta-count":
        // delta rewriting (doc 03 B2.6): counts on shared accounts must be deltas
        if (!s.testid) break;
        assertions.push({
          kind: "delta",
          metric: s.testid,
          read: { kind: "dom-count", locators: [{ kind: "testid", value: s.testid }] },
          assert: "increasedBy",
          value: typeof s.expected === "number" ? s.expected : 1,
          ...(s.description ? { description: s.description } : {}),
        });
        break;
      case "vision":
        if (!s.question || s.expected === undefined) break;
        assertions.push({
          kind: "vision",
          question: s.question,
          assert: "equals",
          value: s.expected,
          ...(s.description ? { description: s.description } : {}),
        });
        break;
    }
  }
  return assertions;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Collect every data-testid mentioned in captured DOM outlines. */
export function collectKnownTestIds(outlines: unknown[]): Set<string> {
  const ids = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as { testid?: string; children?: unknown[] };
    if (n.testid) ids.add(n.testid);
    for (const c of n.children ?? []) walk(c);
  };
  for (const o of outlines) walk(o);
  return ids;
}
