import { z } from "zod";
import { ActionLocatorStackSchema, LocatorStackSchema, ViewportSchema } from "./locators.js";

/**
 * Flow Spec — compiler output, runner input (doc 02 §2–4).
 * Source of truth: docs/02-flow-spec-schema.md. Keep in lockstep.
 */

// ── Settle strategies (doc 02 §3; `flowEvent` from doc 04 §6 state SDK) ────────
export const QuiescenceConfigSchema = z.object({
  sampleEveryMs: z.number().int().positive(),
  stableFrames: z.number().int().positive(),
  diffThresholdPct: z.number().positive(),
});

export const SettleSchema = z
  .object({
    strategy: z.enum([
      "networkidle",
      "navigation",
      "networkidle+animation",
      "animationQuiescence",
      "timeout",
      "flowEvent",
    ]),
    timeoutMs: z.number().int().positive(),
    quiescence: QuiescenceConfigSchema.optional(),
    /** Required when strategy is `flowEvent` (state SDK custom event name). */
    event: z.string().min(1).optional(),
  })
  .superRefine((s, ctx) => {
    if (s.strategy === "flowEvent" && !s.event) {
      ctx.addIssue({ code: "custom", message: "settle.event is required for strategy=flowEvent" });
    }
  });

// ── Assertions (doc 02 §3 "Assertion kinds") ───────────────────────────────────
export const DomAssertionSchema = z
  .object({
    kind: z.literal("dom"),
    assert: z.enum(["visible", "hidden", "enabled", "textMatches", "countEquals", "attrEquals"]),
    locators: LocatorStackSchema,
    value: z.union([z.string(), z.number()]).optional(),
    attr: z.string().optional(),
    description: z.string().optional(),
  })
  .superRefine((a, ctx) => {
    if (a.assert === "textMatches" && typeof a.value !== "string") {
      ctx.addIssue({ code: "custom", message: "textMatches requires a string value" });
    }
    if (a.assert === "countEquals" && typeof a.value !== "number") {
      ctx.addIssue({ code: "custom", message: "countEquals requires a numeric value" });
    }
    if (a.assert === "attrEquals" && (!a.attr || a.value === undefined)) {
      ctx.addIssue({ code: "custom", message: "attrEquals requires attr and value" });
    }
  });

export const UrlAssertionSchema = z.object({
  kind: z.literal("url"),
  assert: z.enum(["pathMatches", "equals"]),
  /** Regex allowed for pathMatches. */
  value: z.string().min(1),
  description: z.string().optional(),
});

export const DeltaReadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dom-count"), locators: LocatorStackSchema }),
  z.object({ kind: z.literal("dom-number"), locators: LocatorStackSchema }),
  z.object({ kind: z.literal("state"), path: z.string().min(1) }),
]);

/**
 * Delta assertions: read a numeric metric at flow start, re-read at the step, compare.
 * Default style for anything touching persistent data (shared test account, doc 07 §2).
 */
export const DeltaAssertionSchema = z
  .object({
    kind: z.literal("delta"),
    metric: z.string().min(1),
    read: DeltaReadSchema,
    assert: z.enum(["increasedBy", "decreasedBy", "changedBy", "unchanged"]),
    value: z.number().optional(),
    description: z.string().optional(),
  })
  .superRefine((a, ctx) => {
    if (a.assert !== "unchanged" && a.value === undefined) {
      ctx.addIssue({ code: "custom", message: `${a.assert} requires a numeric value` });
    }
  });

export const StateAssertionSchema = z.object({
  kind: z.literal("state"),
  /** window path, e.g. "window.__flowState.cardsRevealed" */
  read: z.string().min(1),
  assert: z.literal("equals"),
  value: z.union([z.string(), z.number(), z.boolean()]),
  /** true → skip silently if the state hook doesn't exist (paired vision assertion covers). */
  optional: z.boolean().optional(),
  description: z.string().optional(),
});

/** Only assertion kind allowed to consult a model at runtime, and only at settle points. */
export const VisionAssertionSchema = z.object({
  kind: z.literal("vision"),
  question: z.string().min(1),
  assert: z.enum(["equals", "contains", "yesno"]),
  value: z.union([z.string(), z.number(), z.boolean()]),
  description: z.string().optional(),
});

export const NetworkAssertionSchema = z.object({
  kind: z.literal("network"),
  assert: z.literal("requestSucceeded"),
  method: z.string().min(1),
  urlPattern: z.string().min(1),
  statusClass: z.enum(["2xx", "3xx", "4xx", "5xx"]).default("2xx"),
  description: z.string().optional(),
});

export const ConsoleAssertionSchema = z.object({
  kind: z.literal("console"),
  assert: z.literal("noNewErrorsMatching"),
  pattern: z.string().min(1),
  description: z.string().optional(),
});

export const AssertionSchema = z.union([
  DomAssertionSchema,
  UrlAssertionSchema,
  DeltaAssertionSchema,
  StateAssertionSchema,
  VisionAssertionSchema,
  NetworkAssertionSchema,
  ConsoleAssertionSchema,
]);

export type Assertion = z.infer<typeof AssertionSchema>;

// ── Actions (doc 02 §2 step.action; DOM actions require ≥2 locators) ──────────
export const ClickActionSchema = z.object({
  type: z.literal("click"),
  locators: ActionLocatorStackSchema,
});

export const TypeActionSchema = z.object({
  type: z.literal("type"),
  locators: ActionLocatorStackSchema,
  /** May contain `{{secret:*}}` placeholders, substituted at keystroke time (doc 04 §3). */
  value: z.string(),
});

export const PressActionSchema = z.object({
  type: z.literal("press"),
  key: z.string().min(1),
  locators: ActionLocatorStackSchema.optional(),
});

export const SelectActionSchema = z.object({
  type: z.literal("select"),
  locators: ActionLocatorStackSchema,
  value: z.string(),
});

export const ScrollActionSchema = z
  .object({
    type: z.literal("scroll"),
    locators: ActionLocatorStackSchema.optional(),
    y: z.number().optional(),
  })
  .superRefine((a, ctx) => {
    if (!a.locators && a.y === undefined) {
      ctx.addIssue({ code: "custom", message: "scroll requires locators or y" });
    }
  });

export const NavigateActionSchema = z.object({
  type: z.literal("navigate"),
  /** Appended to the deployment base URL. */
  path: z.string().startsWith("/"),
});

export const WaitForActionSchema = z.object({
  type: z.literal("waitFor"),
  locators: ActionLocatorStackSchema,
  state: z.enum(["visible", "hidden"]).default("visible"),
});

export const CanvasClickActionSchema = z.object({
  type: z.literal("canvasClick"),
  canvasLocator: LocatorStackSchema,
  /** Normalized coords from recording; valid at spec viewport. null → vision grounding. */
  point: z.object({ nx: z.number().min(0).max(1), ny: z.number().min(0).max(1) }).nullable(),
  visionFallback: z.object({ describe: z.string().min(1) }).optional(),
});

/** Typed step, not recorded clicks — runner drives the provider natively (doc 02 §3). */
export const PaymentActionSchema = z.object({
  type: z.literal("payment"),
  provider: z.enum(["stripe", "paypal_sandbox", "razorpay_test", "custom"]),
  variant: z.enum(["card", "card_3ds"]),
  /** Resolves to the payment config bundle (doc 07); PR scope may override. */
  configRef: z.string().default("project"),
});

export const CustomActionSchema = z.object({
  type: z.literal("custom"),
  params: z.record(z.string(), z.unknown()),
});

export const ActionSchema = z.discriminatedUnion("type", [
  ClickActionSchema,
  TypeActionSchema,
  PressActionSchema,
  SelectActionSchema,
  ScrollActionSchema,
  NavigateActionSchema,
  WaitForActionSchema,
  CanvasClickActionSchema,
  PaymentActionSchema,
  CustomActionSchema,
]);

export type Action = z.infer<typeof ActionSchema>;

// ── Steps & spec ───────────────────────────────────────────────────────────────
export const StepCaveatSchema = z.enum(["webhook_dependent"]);

export const FlowStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  intent: z.string().optional(),
  action: ActionSchema,
  settle: SettleSchema,
  /** ALL must hold after settle. */
  postConditions: z.array(AssertionSchema).default([]),
  /** Joins to perf baselines (doc 05 §4). */
  timingBaselineKey: z.string().optional(),
  caveats: z.array(StepCaveatSchema).optional(),
});

export type FlowStep = z.infer<typeof FlowStepSchema>;

export const BudgetsSchema = z.object({
  /** hard=null → perf issues are warnings only (default). */
  flowTotalMs: z
    .object({
      soft: z.number().int().positive().nullable(),
      hard: z.number().int().positive().nullable(),
    })
    .default({ soft: null, hard: null }),
  /** Dual-threshold gate vs baseline (doc 04 §4). */
  perStepDefaults: z
    .object({
      relativeFactor: z.number().positive(),
      absoluteFloorMs: z.number().int().nonnegative(),
    })
    .default({ relativeFactor: 3.0, absoluteFloorMs: 500 }),
});

export const CoverageBlockSchema = z.object({
  files: z.array(z.string()),
  apiRoutes: z.array(z.string()),
  collectedAtSha: z.string().min(1),
  collectedAt: z.iso.datetime(),
});

export const FLOW_SPEC_VERSION = 3 as const;

export const FlowSpecSchema = z.object({
  /** Schema version of this document format. */
  specVersion: z.literal(FLOW_SPEC_VERSION),
  flowId: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  /** "smoke" always runs; "standard" subject to diff-aware selection. */
  tier: z.enum(["smoke", "standard"]).default("standard"),
  /** Key into credential resolution (doc 07); null = unauthenticated flow. */
  persona: z.string().nullable().default(null),
  /** Appended to the deployment base URL. */
  startPath: z.string().startsWith("/"),
  viewport: ViewportSchema.default({ width: 1280, height: 720, dpr: 1 }),
  env: z.object({ requiresWebGL: z.boolean().optional() }).default({}),
  budgets: BudgetsSchema.prefault({}),
  steps: z.array(FlowStepSchema).min(1),
  /** Written back after runs; consumed by diff-aware selection (doc 06). */
  coverage: CoverageBlockSchema.optional(),
});

export type FlowSpec = z.infer<typeof FlowSpecSchema>;
export type FlowSpecInput = z.input<typeof FlowSpecSchema>;

/** Version statuses (doc 02 §4 / doc 08). */
export const FlowSpecVersionStatusSchema = z.enum([
  "draft",
  "official",
  "pending",
  "quarantined",
  "archived",
]);
export type FlowSpecVersionStatus = z.infer<typeof FlowSpecVersionStatusSchema>;
