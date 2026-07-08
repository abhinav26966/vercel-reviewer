import type { ZodType } from "zod";

/**
 * The ONLY gateway to LLM providers (doc 01 §2): three capability interfaces,
 * never call providers directly outside this package. v1 backends are hosted
 * OpenAI-compatible APIs (open-weights via OpenRouter/etc, Ollama, or Anthropic's
 * compat endpoint); v2 adds a shared self-hosted vLLM node.
 */

export interface InferenceImage {
  data: Buffer;
  mediaType: "image/jpeg" | "image/png";
  /** Shown to the model before the image so multi-image prompts stay legible. */
  label?: string;
}

export interface VisionAnalyzeOptions<T> {
  system?: string;
  prompt: string;
  images: InferenceImage[];
  /** Structured-output contract: response is Zod-parsed with ONE repair retry (doc 09 Phase 6). */
  schema: ZodType<T>;
  maxTokens?: number;
}

export interface Grounding {
  /** Normalized coordinates (0..1) relative to the supplied image. */
  nx: number;
  ny: number;
  confidence: number;
}

export interface InferenceUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
}

export interface InferenceResult<T> {
  result: T;
  usage: InferenceUsage;
}

export interface InferenceProvider {
  /** Strong multimodal: compile passes, flow-level analysis (doc 01 §5). */
  visionAnalyze<T>(opts: VisionAnalyzeOptions<T>): Promise<InferenceResult<T>>;
  /** Cheap vision with coordinate output (locator-miss/canvas fallback, doc 04 §3). */
  groundElement(opts: { image: InferenceImage; describe: string }): Promise<InferenceResult<Grounding | null>>;
  /** Divergence judging (doc 05 §§2–3); full evidence assembly lands in Phase 9. */
  judge<T>(opts: VisionAnalyzeOptions<T>): Promise<InferenceResult<T>>;
}

/** Prompt/response artifact logging hook — inputs are pre-redacted (doc 07 §4.3). */
export type InferenceLogSink = (entry: {
  capability: "analyze" | "ground" | "judge";
  model: string;
  prompt: string;
  response: string;
  usage: InferenceUsage;
}) => void;
