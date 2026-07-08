import { z } from "zod";
import { FlowSpecSchema } from "./flow-spec.js";
import { RunTargetSchema } from "./run-result.js";

/**
 * ExecuteFlowJob — the runner's job contract (doc 04 §1).
 * Secrets arrive as `sec_*` REFERENCES; the runner resolves them from the vault at
 * the last moment and registers each plaintext with the redaction registry before
 * any logging can occur (doc 07 §4).
 */

export const PersonaConfigSchema = z.object({
  name: z.string().min(1),
  usernameRef: z.string().min(1),
  passwordRef: z.string().min(1),
  /** Cached storageState S3 key for (persona, deployment); null = login required. */
  storageStateKey: z.string().nullable().default(null),
  /**
   * The project's Login flow spec, executed once per (persona, deployment) in a
   * throwaway context (no video/trace/HAR — secrets never enter flow artifacts)
   * when no cached storageState exists (doc 07 §5).
   */
  loginSpec: z.lazy(() => FlowSpecSchema).nullable().default(null),
});

export const PaymentBundleSchema = z.object({
  provider: z.enum(["stripe", "paypal_sandbox", "razorpay_test", "custom"]),
  cardRef: z.string().min(1),
  expiry: z.string().min(1),
  /** Secret reference — never plaintext in the job payload (doc 07 §4.2). */
  cvcRef: z.string().min(1),
  source: z.enum(["project", "pr"]),
  extras: z.record(z.string(), z.unknown()).default({}),
});

/** Resolved per deployment TARGET, not per run (doc 07 §3). */
export const ConfigBundleSchema = z.object({
  persona: PersonaConfigSchema.nullable().default(null),
  payment: PaymentBundleSchema.nullable().default(null),
  /**
   * Placeholder → secret-reference map for `{{secret:persona.field}}` values in
   * type actions, pre-resolved per target by the orchestrator (scope hierarchy
   * lives there; the runner only ever exchanges refs for plaintext).
   */
  secretRefs: z.record(z.string(), z.string()).default({}),
  /** head resolved from PR scope (or user-flagged) → passed to runner AND judge. */
  dataBranchDiffers: z.boolean().default(false),
});

export type ConfigBundle = z.infer<typeof ConfigBundleSchema>;

export const DeploymentTargetSchema = z.object({
  kind: RunTargetSchema,
  deploymentUrl: z.url(),
  /** Vercel Protection Bypass for Automation secret; null when protection is off. */
  bypassSecret: z.string().nullable().default(null),
  sha: z.string().min(1),
  /** FlowGuard deployments-row id — keys the storageState cache (doc 07 §5). */
  deploymentId: z.string().nullable().default(null),
});

export const RunModeSchema = z.enum(["warmup", "measure", "validate", "explore"]);

export const ExecuteFlowJobSchema = z.object({
  runId: z.string().min(1),
  flowId: z.string().min(1),
  specVersionId: z.string().min(1),
  /** The full spec — runners are stateless and receive it inline (doc 01 §1). */
  spec: FlowSpecSchema,
  target: DeploymentTargetSchema,
  configBundle: ConfigBundleSchema,
  mode: RunModeSchema,
  collect: z.object({
    coverage: z.boolean().default(false),
    har: z.boolean().default(true),
    video: z.boolean().default(true),
  }),
  abortToken: z.string().nullable().default(null),
});

export type ExecuteFlowJob = z.infer<typeof ExecuteFlowJobSchema>;
