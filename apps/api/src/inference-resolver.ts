import { createInference, type InferenceProvider } from "@flowguard/inference";
import { ProjectSettingsSchema } from "@flowguard/schemas";
import type { Store } from "./store.js";

/**
 * Bring-your-own inference (doc 09 Phase 13). A project with its own key +
 * model chains gets a provider built from them (vision/judge quality is its
 * cost); otherwise the platform default provider is used, so the product works
 * with zero configuration. Token usage is metered per project via the log sink.
 */
export async function resolveProjectInference(params: {
  projectId: string;
  settings: unknown;
  store: Store;
  resolveSecret: (ref: string) => Promise<string>;
  platform: InferenceProvider;
}): Promise<InferenceProvider> {
  const settings = ProjectSettingsSchema.parse(params.settings ?? {});
  const inf = settings.inference;
  if (!inf.keyRef) return params.platform;
  let apiKey: string;
  try {
    apiKey = await params.resolveSecret(inf.keyRef);
  } catch {
    // a broken BYO key must not take the project offline — fall back to platform
    return params.platform;
  }
  return createInference({
    apiKey,
    baseUrl: inf.baseUrl,
    analyzeModels: inf.analyzeModels,
    groundingModels: inf.groundingModels,
    judgeModels: inf.judgeModels,
    logSink: (e) => {
      void params.store
        .recordUsage({
          projectId: params.projectId,
          kind: "inference_tokens",
          amount: e.usage.promptTokens + e.usage.completionTokens,
          model: e.usage.model,
        })
        .catch(() => {});
    },
  });
}
