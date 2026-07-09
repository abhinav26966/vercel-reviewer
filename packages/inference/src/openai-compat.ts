import { z } from "zod";
import { globalRedaction } from "@flowguard/shared";
import type {
  Grounding,
  InferenceImage,
  InferenceLogSink,
  InferenceProvider,
  InferenceResult,
  InferenceUsage,
  VisionAnalyzeOptions,
} from "./types.js";

/**
 * OpenAI-compatible chat-completions backend. One client covers OpenRouter
 * (open-weights models incl. :free tiers), Ollama, vLLM, and Anthropic's compat
 * endpoint. Free tiers rate-limit aggressively, so every capability takes a
 * MODEL FALLBACK CHAIN tried in order on 429/5xx.
 */
export interface OpenAICompatConfig {
  baseUrl: string;
  apiKey: string;
  /** Fallback chains per capability, tried in order on 429/503. */
  analyzeModels: string[];
  groundingModels: string[];
  judgeModels: string[];
  fetchImpl?: typeof fetch;
  logSink?: InferenceLogSink;
  /** Backoff between model attempts (test override). */
  retryDelayMs?: number;
}

interface ChatMessage {
  role: "system" | "user";
  content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 524]);

/** Upstream flake phrasings that arrive without a retryable code (free tiers). */
const RETRYABLE_MESSAGE = /timeout|timed out|overloaded|temporarily/i;

export class OpenAICompatProvider implements InferenceProvider {
  constructor(private readonly config: OpenAICompatConfig) {}

  async visionAnalyze<T>(opts: VisionAnalyzeOptions<T>): Promise<InferenceResult<T>> {
    return this.structured("analyze", this.config.analyzeModels, opts);
  }

  async judge<T>(opts: VisionAnalyzeOptions<T>): Promise<InferenceResult<T>> {
    return this.structured("judge", this.config.judgeModels, opts);
  }

  async groundElement(opts: {
    image: InferenceImage;
    describe: string;
  }): Promise<InferenceResult<Grounding | null>> {
    const schema = z.object({
      found: z.boolean(),
      nx: z.number().min(0).max(1).optional(),
      ny: z.number().min(0).max(1).optional(),
      confidence: z.number().min(0).max(1).optional(),
    });
    const res = await this.structured("ground", this.config.groundingModels, {
      prompt:
        `Locate this element in the screenshot: "${opts.describe}".\n` +
        `Respond ONLY with JSON: {"found": boolean, "nx": <0..1 horizontal center>, "ny": <0..1 vertical center>, "confidence": <0..1>}. ` +
        `If the element is not visible, {"found": false}.`,
      images: [opts.image],
      schema,
      maxTokens: 120,
    });
    const g = res.result;
    return {
      usage: res.usage,
      result:
        g.found && g.nx !== undefined && g.ny !== undefined
          ? { nx: g.nx, ny: g.ny, confidence: g.confidence ?? 0.5 }
          : null,
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async structured<T>(
    capability: "analyze" | "ground" | "judge",
    models: string[],
    opts: VisionAnalyzeOptions<T>,
  ): Promise<InferenceResult<T>> {
    const messages = buildMessages(opts);
    let lastError: unknown;
    for (const model of models) {
      try {
        const first = await this.complete(model, messages, opts.maxTokens ?? 1500);
        const parsed = tryParse(opts.schema, first.text);
        if (parsed.ok) {
          this.log(capability, model, opts.prompt, first.text, first.usage);
          return { result: parsed.value, usage: first.usage };
        }
        // ONE repair retry: feed the validation error back (doc 09 Phase 6)
        const repairMessages: ChatMessage[] = [
          ...messages,
          { role: "user", content: `Your previous response failed validation: ${parsed.error}\nPrevious response: ${first.text.slice(0, 2000)}\nRespond again with ONLY the corrected JSON.` },
        ];
        const second = await this.complete(model, repairMessages, opts.maxTokens ?? 1500);
        const reparsed = tryParse(opts.schema, second.text);
        this.log(capability, model, opts.prompt, second.text, second.usage);
        if (reparsed.ok) return { result: reparsed.value, usage: second.usage };
        throw new Error(`structured output failed after repair retry: ${reparsed.error}`);
      } catch (err) {
        lastError = err;
        if (err instanceof RetryableProviderError) {
          await sleep(this.config.retryDelayMs ?? 1500);
          continue; // next model in the chain
        }
        throw err;
      }
    }
    throw new Error(`all models exhausted for ${capability}: ${String(lastError)}`);
  }

  private async complete(
    model: string,
    messages: ChatMessage[],
    maxTokens: number,
  ): Promise<{ text: string; usage: InferenceUsage }> {
    const res = await (this.config.fetchImpl ?? fetch)(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json",
        "x-title": "FlowGuard",
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0.1, messages }),
    });
    const bodyText = await res.text();
    if (!res.ok) {
      if (RETRYABLE.has(res.status)) {
        throw new RetryableProviderError(`${model} → ${res.status}: ${bodyText.slice(0, 200)}`);
      }
      throw new Error(`inference request failed (${res.status}): ${bodyText.slice(0, 300)}`);
    }
    const body = JSON.parse(bodyText) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { code?: number; message?: string };
    };
    // OpenRouter tunnels upstream provider errors inside 200 responses
    if (body.error) {
      if (RETRYABLE.has(body.error.code ?? 0) || RETRYABLE_MESSAGE.test(body.error.message ?? "")) {
        throw new RetryableProviderError(`${model} → upstream ${body.error.code}: ${body.error.message}`);
      }
      throw new Error(`inference provider error: ${body.error.message}`);
    }
    const text = body.choices?.[0]?.message?.content ?? "";
    if (!text) throw new RetryableProviderError(`${model} returned an empty completion`);
    return {
      text,
      usage: {
        model,
        promptTokens: body.usage?.prompt_tokens ?? 0,
        completionTokens: body.usage?.completion_tokens ?? 0,
      },
    };
  }

  private log(
    capability: "analyze" | "ground" | "judge",
    model: string,
    prompt: string,
    response: string,
    usage: InferenceUsage,
  ): void {
    // secrets never enter model context by design (doc 07 §4.4) — redact anyway
    this.config.logSink?.({
      capability,
      model,
      prompt: globalRedaction.redactString(prompt),
      response: globalRedaction.redactString(response),
      usage,
    });
  }
}

export class RetryableProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableProviderError";
  }
}

function buildMessages<T>(opts: VisionAnalyzeOptions<T>): ChatMessage[] {
  const content: Extract<ChatMessage["content"], unknown[]> = [];
  content.push({ type: "text", text: opts.prompt });
  for (const image of opts.images) {
    if (image.label) content.push({ type: "text", text: `[image: ${image.label}]` });
    content.push({
      type: "image_url",
      image_url: { url: `data:${image.mediaType};base64,${image.data.toString("base64")}` },
    });
  }
  const messages: ChatMessage[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content });
  return messages;
}

/** Models fence/preamble JSON — extract the first balanced object or array. */
export function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.search(/[[{]/);
  if (start === -1) return null;
  const open = candidate[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return null;
}

function tryParse<T>(schema: ZodTypeLike<T>, text: string): { ok: true; value: T } | { ok: false; error: string } {
  const json = extractJson(text);
  if (!json) return { ok: false, error: "no JSON object found in response" };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${String(err).slice(0, 120)}` };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  }
  return { ok: true, value: parsed.data };
}

interface ZodTypeLike<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: (string | number | symbol)[]; message: string }> } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
