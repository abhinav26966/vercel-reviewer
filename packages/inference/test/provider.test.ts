import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { globalRedaction } from "@flowguard/shared";
import { extractJson, OpenAICompatProvider } from "../src/openai-compat.js";

function providerWith(
  responses: Array<{ status: number; content?: string; error?: { code: number; message: string } }>,
  logSink?: Parameters<typeof OpenAICompatProvider.prototype.visionAnalyze>[0] extends never ? never : (e: unknown) => void,
) {
  let call = 0;
  const requests: Array<{ model: string; messages: unknown[] }> = [];
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string) as { model: string; messages: unknown[] };
    requests.push(body);
    const r = responses[Math.min(call++, responses.length - 1)]!;
    const payload = r.error
      ? { error: r.error }
      : { choices: [{ message: { content: r.content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    return new Response(JSON.stringify(payload), { status: r.status });
  }) as unknown as typeof fetch;
  const provider = new OpenAICompatProvider({
    baseUrl: "https://fake.local/v1",
    apiKey: "k",
    analyzeModels: ["model-a", "model-b"],
    groundingModels: ["ground-a"],
    judgeModels: ["model-a"],
    fetchImpl,
    retryDelayMs: 1,
    ...(logSink ? { logSink: logSink as never } : {}),
  });
  return { provider, requests };
}

const schema = z.object({ page: z.string() });
const image = { data: Buffer.from("img"), mediaType: "image/jpeg" as const };

describe("extractJson", () => {
  it("handles fenced, preambled, and nested JSON", () => {
    expect(extractJson('Sure! ```json\n{"a": 1}\n```')).toBe('{"a": 1}');
    expect(extractJson('Here you go: {"a": {"b": "}"}} trailing')).toBe('{"a": {"b": "}"}}');
    expect(extractJson("no json here")).toBeNull();
  });
});

describe("OpenAICompatProvider", () => {
  it("sends prompt + labeled data-URL images and parses structured output", async () => {
    const { provider, requests } = providerWith([{ status: 200, content: '{"page": "login"}' }]);
    const res = await provider.visionAnalyze({
      prompt: "what page?",
      images: [{ ...image, label: "after screenshot" }],
      schema,
    });
    expect(res.result).toEqual({ page: "login" });
    expect(res.usage.model).toBe("model-a");
    const content = (requests[0]!.messages[0] as { content: Array<{ type: string; text?: string; image_url?: { url: string } }> }).content;
    expect(content[0]).toEqual({ type: "text", text: "what page?" });
    expect(content[1]).toEqual({ type: "text", text: "[image: after screenshot]" });
    expect(content[2]!.image_url!.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("repairs invalid structured output once with the validation error", async () => {
    const { provider, requests } = providerWith([
      { status: 200, content: '{"wrong": true}' },
      { status: 200, content: '{"page": "shop"}' },
    ]);
    const res = await provider.visionAnalyze({ prompt: "p", images: [image], schema });
    expect(res.result).toEqual({ page: "shop" });
    expect(requests).toHaveLength(2);
    const repair = (requests[1]!.messages.at(-1) as { content: string }).content;
    expect(repair).toContain("failed validation");
  });

  it("falls through the model chain on 429s (free-tier reality)", async () => {
    const { provider, requests } = providerWith([
      { status: 429, content: "rate limited" },
      { status: 200, content: '{"page": "inventory"}' },
    ]);
    const res = await provider.visionAnalyze({ prompt: "p", images: [image], schema });
    expect(res.result).toEqual({ page: "inventory" });
    expect(requests.map((r) => r.model)).toEqual(["model-a", "model-b"]);
  });

  it("handles OpenRouter's tunneled upstream 429 inside a 200 body", async () => {
    const { provider, requests } = providerWith([
      { status: 200, error: { code: 429, message: "temporarily rate-limited upstream" } },
      { status: 200, content: '{"page": "open"}' },
    ]);
    const res = await provider.visionAnalyze({ prompt: "p", images: [image], schema });
    expect(res.result).toEqual({ page: "open" });
    expect(requests.map((r) => r.model)).toEqual(["model-a", "model-b"]);
  });

  it("throws after exhausting the chain", async () => {
    const { provider } = providerWith([{ status: 429 }, { status: 429 }]);
    await expect(provider.visionAnalyze({ prompt: "p", images: [image], schema })).rejects.toThrow(
      "all models exhausted",
    );
  });

  it("groundElement returns normalized coords or null", async () => {
    const found = providerWith([{ status: 200, content: '{"found": true, "nx": 0.5, "ny": 0.62, "confidence": 0.9}' }]);
    expect((await found.provider.groundElement({ image, describe: "the pack" })).result).toEqual({
      nx: 0.5,
      ny: 0.62,
      confidence: 0.9,
    });
    const missing = providerWith([{ status: 200, content: '{"found": false}' }]);
    expect((await missing.provider.groundElement({ image, describe: "ghost" })).result).toBeNull();
  });

  it("redacts registered secrets from logged prompts/responses", async () => {
    globalRedaction.register("sup3r-s3cret-value");
    const logged: Array<{ prompt: string; response: string }> = [];
    const { provider } = providerWith(
      [{ status: 200, content: '{"page": "echo sup3r-s3cret-value"}' }],
      ((e: { prompt: string; response: string }) => logged.push(e)) as never,
    );
    await provider.visionAnalyze({
      prompt: "contains sup3r-s3cret-value oops",
      images: [image],
      schema,
    });
    expect(logged[0]!.prompt).not.toContain("sup3r-s3cret-value");
    expect(logged[0]!.response).not.toContain("sup3r-s3cret-value");
    expect(logged[0]!.prompt).toContain("«redacted»");
  });
});
