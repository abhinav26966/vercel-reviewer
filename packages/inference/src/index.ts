export * from "./types.js";
export * from "./openai-compat.js";

import type { InferenceLogSink } from "./types.js";
import { OpenAICompatProvider } from "./openai-compat.js";

/**
 * Default free open-weights lineup (OpenRouter), chosen per doc 01 §5:
 * strong multimodal for compile/judge, cheap vision for grounding. Free tiers
 * rate-limit upstream, hence the chains. Override via INFERENCE_* env vars.
 */
export const DEFAULT_ANALYZE_MODELS = [
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-nano-12b-v2-vl:free",
];
export const DEFAULT_GROUNDING_MODELS = [
  "nvidia/nemotron-nano-12b-v2-vl:free",
  "google/gemma-4-26b-a4b-it:free",
];
export const DEFAULT_JUDGE_MODELS = DEFAULT_ANALYZE_MODELS;

export function createInferenceFromEnv(opts?: {
  env?: NodeJS.ProcessEnv;
  logSink?: InferenceLogSink;
}): OpenAICompatProvider {
  const env = opts?.env ?? process.env;
  const apiKey = env.INFERENCE_API_KEY;
  if (!apiKey) throw new Error("INFERENCE_API_KEY is required (see apps/api/.env.example)");
  const chain = (value: string | undefined, fallback: string[]) =>
    value ? value.split(",").map((s) => s.trim()) : fallback;
  return new OpenAICompatProvider({
    baseUrl: env.INFERENCE_BASE_URL ?? "https://openrouter.ai/api/v1",
    apiKey,
    analyzeModels: chain(env.INFERENCE_ANALYZE_MODELS, DEFAULT_ANALYZE_MODELS),
    groundingModels: chain(env.INFERENCE_GROUNDING_MODELS, DEFAULT_GROUNDING_MODELS),
    judgeModels: chain(env.INFERENCE_JUDGE_MODELS, DEFAULT_JUDGE_MODELS),
    ...(opts?.logSink ? { logSink: opts.logSink } : {}),
  });
}

/**
 * Bring-your-own inference (doc 09 Phase 13): build a provider from an explicit
 * key + per-capability model chains. Empty model chains fall back to the
 * platform defaults, so a project can override only what it cares about (e.g.
 * point vision at Claude, leave judging on the free tier).
 */
export function createInference(config: {
  apiKey: string;
  baseUrl?: string | null;
  analyzeModels?: string[];
  groundingModels?: string[];
  judgeModels?: string[];
  logSink?: InferenceLogSink;
}): OpenAICompatProvider {
  const orDefault = (chain: string[] | undefined, fallback: string[]) =>
    chain && chain.length > 0 ? chain : fallback;
  return new OpenAICompatProvider({
    baseUrl: config.baseUrl || "https://openrouter.ai/api/v1",
    apiKey: config.apiKey,
    analyzeModels: orDefault(config.analyzeModels, DEFAULT_ANALYZE_MODELS),
    groundingModels: orDefault(config.groundingModels, DEFAULT_GROUNDING_MODELS),
    judgeModels: orDefault(config.judgeModels, DEFAULT_JUDGE_MODELS),
    ...(config.logSink ? { logSink: config.logSink } : {}),
  });
}
