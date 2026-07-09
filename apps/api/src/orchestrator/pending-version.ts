import { FlowSpecSchema, type FlowSpec } from "@flowguard/schemas";
import { z } from "zod";
import type { Store } from "../store.js";

/**
 * Approved 🔵 / accepted spec-drift → a `pending` spec version (doc 05 §3.6).
 * Pending versions are NEVER run against PRs; the base-branch merge run
 * reconciles them (promote | hold) in Phase 10.
 */

/** The only patch shape the runner's heal agent proposes (doc 04 §5). */
export const HealPatchSchema = z.object({
  stepId: z.string().min(1),
  locators: z.array(z.unknown()).min(1),
});

export function applyHealPatch(spec: FlowSpec, patch: unknown): FlowSpec {
  const parsed = HealPatchSchema.safeParse(patch);
  if (!parsed.success) return spec;
  const { stepId, locators } = parsed.data;
  const patched = FlowSpecSchema.safeParse({
    ...spec,
    steps: spec.steps.map((s) =>
      s.id === stepId && "locators" in s.action ? { ...s, action: { ...s.action, locators } } : s,
    ),
  });
  // a patch that yields an invalid spec (e.g. too few locators) is dropped
  return patched.success ? patched.data : spec;
}

/**
 * Mint a pending version from the head run's accepted behavior: the official
 * spec, plus the heal agent's locator patch when one exists.
 */
export async function createPendingVersion(params: {
  store: Store;
  flowId: string;
  runId: string;
  branch: string;
  note: string;
}): Promise<string | null> {
  const { store, flowId, runId, branch } = params;
  const official = await store.getOfficialVersion(flowId, branch);
  if (!official) return null;

  const headResult = await store.getRunFlowResult(runId, flowId, "head");
  const patch = headResult?.result.healAttempt.succeeded
    ? headResult.result.healAttempt.proposedPatch
    : null;
  const spec = patch ? applyHealPatch(official.spec, patch) : official.spec;

  return store.insertFlowVersion({
    flowId,
    spec,
    status: "pending",
    branch,
    source: "baseline_promotion",
    supersedesVersionId: official.id,
    approvedFromRunId: runId,
    compilationReport: {
      note: params.note,
      healPatchApplied: Boolean(patch),
    },
  });
}
