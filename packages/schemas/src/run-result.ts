import { z } from "zod";
import { TraceNetworkEntrySchema } from "./recording-trace.js";

/**
 * RunFlowResult — runner output (doc 02 §5).
 * `error` status exists so environment problems (deployment 404, bypass rejected,
 * login upstream down) are never reported as flow failures.
 */

export const RunTargetSchema = z.enum(["head", "base"]);
export type RunTarget = z.infer<typeof RunTargetSchema>;

export const RunFlowStatusSchema = z.enum([
  "passed",
  "failed",
  "hung",
  "dead",
  "error",
  "skipped",
]);
export type RunFlowStatus = z.infer<typeof RunFlowStatusSchema>;

export const FailureClassSchema = z.enum([
  "locator_miss",
  "assertion",
  "hung_postcondition",
  "crash",
  "blank_screen",
  "payment_unverified_env",
  "grounding_failed",
  "login_failed",
  "env",
]);
export type FailureClass = z.infer<typeof FailureClassSchema>;

export const StepAssertionResultSchema = z.object({
  kind: z.enum(["dom", "url", "delta", "state", "vision", "network", "console"]),
  pass: z.boolean(),
  message: z.string().optional(),
  /** true when an optional state assertion found no hook and was skipped. */
  skipped: z.boolean().optional(),
});

export const StepResultSchema = z.object({
  id: z.string().min(1),
  durationMs: z.number().nonnegative(),
  settleMs: z.number().nonnegative(),
  network: z.array(TraceNetworkEntrySchema).default([]),
  /** Artifact key; null when the throttled screenshotter skipped a passing step. */
  screenshot: z.string().nullable(),
  assertions: z.array(StepAssertionResultSchema).default([]),
});

export const PerfAttributionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("network"),
    request: z.string().min(1),
    baseTtfb: z.number().nonnegative(),
    headTtfb: z.number().nonnegative(),
  }),
  z.object({
    kind: z.literal("client"),
    longTasks: z.number().nonnegative().optional(),
    settleDelta: z.number().optional(),
  }),
]);

export const PerfRegressionSchema = z.object({
  stepId: z.string().min(1),
  baseMs: z.number().nonnegative(),
  headMs: z.number().nonnegative(),
  /** Attribution required before flagging (doc 04 §4). */
  attribution: PerfAttributionSchema,
});

export const RunArtifactsSchema = z.object({
  video: z.string().nullable(),
  trace: z.string().nullable(),
  har: z.string().nullable(),
  console: z.string().nullable(),
  coverage: z.string().nullable(),
});

export const PendingRequestSchema = z.object({
  method: z.string().min(1),
  url: z.string().min(1),
  pendingMs: z.number().nonnegative(),
});

export const RunDiagnosticsSchema = z.object({
  pendingRequestsAtTimeout: z.array(PendingRequestSchema).default([]),
  consoleErrors: z.array(z.object({ ts: z.number().optional(), text: z.string() })).default([]),
  pageCrashed: z.boolean().default(false),
  nextErrorOverlay: z.boolean().default(false),
  /** Fraction of near-uniform pixels in the settle screenshot (doc 04 §4 "Dead"). */
  blankScreenScore: z.number().min(0).max(1).default(0),
  /** Human phrase from the hung/dead classifier, e.g. "Next.js error overlay present". */
  failureDetail: z.string().nullable().default(null),
  /** Heal-agent action log (doc 04 §5) — judge evidence on heal failure. */
  healTranscript: z.array(z.string()).default([]),
});

export const HealAttemptSchema = z.object({
  attempted: z.boolean(),
  succeeded: z.boolean(),
  /** Proposed spec patch; NEVER auto-applied (doc 04 §5). */
  proposedPatch: z.unknown().nullable(),
});

/**
 * Coverage collected over the whole flow (doc 04 §7): repo files come from
 * source-map resolution of executed chunks (chunk-level attribution — an
 * executed chunk attributes all its sources); apiRoutes are URL paths of
 * first-party /api/* requests, mapped to route files at selection time.
 */
export const FlowCoverageSchema = z.object({
  files: z.array(z.string()).default([]),
  apiRoutes: z.array(z.string()).default([]),
  /** false ⇒ source maps unavailable; selection falls back to route heuristics. */
  sourceMapsResolved: z.boolean().default(false),
});
export type FlowCoverage = z.infer<typeof FlowCoverageSchema>;

export const RunFlowResultSchema = z.object({
  runId: z.string().min(1),
  flowId: z.string().min(1),
  specVersionId: z.string().min(1),
  target: RunTargetSchema,
  status: RunFlowStatusSchema,
  failedStepId: z.string().nullable().default(null),
  failureClass: FailureClassSchema.nullable().default(null),
  healAttempt: HealAttemptSchema.default({ attempted: false, succeeded: false, proposedPatch: null }),
  steps: z.array(StepResultSchema).default([]),
  perf: z
    .object({
      flowTotalMs: z.number().nonnegative(),
      regressions: z.array(PerfRegressionSchema).default([]),
    })
    .default({ flowTotalMs: 0, regressions: [] }),
  artifacts: RunArtifactsSchema.default({
    video: null,
    trace: null,
    har: null,
    console: null,
    coverage: null,
  }),
  diagnostics: RunDiagnosticsSchema.prefault({}),
  /** Present only when the job asked for coverage collection (base runs). */
  coverage: FlowCoverageSchema.nullable().default(null),
});

export type RunFlowResult = z.infer<typeof RunFlowResultSchema>;
