import type { ConfigBundleSchema, FlowSpec } from "@flowguard/schemas";
import type { z } from "zod";
import type { Store } from "../store.js";

type ConfigBundle = z.infer<typeof ConfigBundleSchema>;

/**
 * Config bundles resolve per DEPLOYMENT TARGET, not per run (doc 07 §3):
 *   head  → PR-scoped credentials if present, else project defaults
 *   base  → project defaults, always
 * `dataBranchDiffers` = head resolved from PR scope OR user-flagged on the set.
 */

const PLACEHOLDER = /\{\{secret:([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)\}\}/g;

/** All personas a spec needs: its own persona + any placeholder personas. */
export function personasUsedBySpec(spec: FlowSpec): string[] {
  const names = new Set<string>();
  if (spec.persona) names.add(spec.persona);
  for (const step of spec.steps) {
    if (step.action.type === "type") {
      for (const m of step.action.value.matchAll(PLACEHOLDER)) names.add(m[1]!);
    }
  }
  return [...names];
}

export interface BundleContext {
  store: Store;
  projectId: string;
  /** PR number for head-target resolution; null for base targets. */
  prNumber: number | null;
  deploymentId: string | null;
  /** The project's Login flow spec (by convention: flow named "Login"). */
  loginSpec: FlowSpec | null;
}

export class MissingCredentialsError extends Error {
  constructor(readonly persona: string) {
    super(`no credentials configured for persona "${persona}"`);
    this.name = "MissingCredentialsError";
  }
}

export async function buildConfigBundle(ctx: BundleContext, spec: FlowSpec): Promise<ConfigBundle> {
  const personas = personasUsedBySpec(spec);
  const secretRefs: Record<string, string> = {};
  let persona: ConfigBundle["persona"] = null;
  let dataBranchDiffers = false;

  for (const name of personas) {
    const set = await ctx.store.resolveCredentialSet(ctx.projectId, name, ctx.prNumber);
    if (!set) throw new MissingCredentialsError(name);
    if (set.scope === "pr" || set.dataBranchDiffers) dataBranchDiffers = true;
    secretRefs[`${name}.username`] = set.usernameSecretId;
    secretRefs[`${name}.password`] = set.passwordSecretId;

    if (spec.persona === name) {
      const storageStateKey = ctx.deploymentId
        ? await ctx.store.getSessionStateKey(name, ctx.deploymentId)
        : null;
      persona = {
        name,
        usernameRef: set.usernameSecretId,
        passwordRef: set.passwordSecretId,
        storageStateKey,
        loginSpec: ctx.loginSpec,
      };
    }
  }

  // payment bundle (doc 07 §6): same head→PR-scope→project hierarchy; refs
  // only — the runner exchanges them at fill time, AFTER the live-mode guard
  let payment: ConfigBundle["payment"] = null;
  if (spec.steps.some((s) => s.action.type === "payment")) {
    const config = await ctx.store.resolvePaymentConfig(ctx.projectId, ctx.prNumber);
    if (config) {
      payment = {
        provider: config.provider as "stripe" | "paypal_sandbox" | "razorpay_test" | "custom",
        cardRef: config.cardSecretId,
        expiry: config.expiry,
        cvcRef: config.cvcSecretId,
        source: config.scope === "pr" ? "pr" : "project",
        extras: config.extras,
      };
    }
    // missing config → payment stays null; the runner fails the step closed
  }

  return { persona, payment, secretRefs, dataBranchDiffers };
}
