import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import type { InferenceProvider } from "@flowguard/inference";
import { runStepOnce, type StepContext } from "../src/steps.js";
import { NetworkTracker } from "../src/network-tracker.js";
import type { FlowStep } from "../src/types.js";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});
afterAll(async () => {
  await browser?.close();
});

function ctx(over: Partial<StepContext> = {}): StepContext {
  return { page, baseUrl: "data:text/html,x", tracker: new NetworkTracker(), logger: pino({ level: "silent" }), ...over };
}

const groundingProvider = (g: { nx: number; ny: number; confidence: number } | null): InferenceProvider =>
  ({
    visionAnalyze: async () => ({ result: {} as never, usage: { model: "f", promptTokens: 0, completionTokens: 0 } }),
    groundElement: async () => ({ result: g, usage: { model: "f", promptTokens: 0, completionTokens: 0 } }),
    judge: async () => ({ result: {} as never, usage: { model: "f", promptTokens: 0, completionTokens: 0 } }),
  }) as InferenceProvider;

describe("flowEvent settle (doc 04 §6)", () => {
  it("resolves when the app dispatches the named milestone", async () => {
    await page.goto(
      `data:text/html,<button id="go" onclick="setTimeout(function(){window.dispatchEvent(new CustomEvent('flowguard',{detail:{event:'pack_opened'}}))},200)">go</button><div data-testid="done">done</div>`,
    );
    const step: FlowStep = {
      id: "s1",
      title: "click and await milestone",
      action: { type: "click", locators: [{ kind: "css", value: "#go" }, { kind: "text", value: "go" }] },
      settle: { strategy: "flowEvent", timeoutMs: 3000, event: "pack_opened" },
      postConditions: [{ kind: "dom", assert: "visible", locators: [{ kind: "testid", value: "done" }] }],
    } as FlowStep;
    const out = await runStepOnce(ctx(), step);
    expect(out.failure).toBeNull();
    expect(out.settleTimedOut).toBe(false);
  });

  it("times out (records settleTimedOut) when the milestone never fires", async () => {
    await page.goto(`data:text/html,<button id="go">go</button><div data-testid="done">done</div>`);
    const step: FlowStep = {
      id: "s1",
      title: "await milestone that never comes",
      action: { type: "click", locators: [{ kind: "css", value: "#go" }, { kind: "text", value: "go" }] },
      settle: { strategy: "flowEvent", timeoutMs: 800, event: "never" },
      postConditions: [],
    } as FlowStep;
    const out = await runStepOnce(ctx(), step);
    expect(out.settleTimedOut).toBe(true);
  });
});

describe("animationQuiescence settle (doc 04 §6)", () => {
  it("resolves once the frame stops changing", async () => {
    // a box that animates for ~600ms then stops
    await page.goto(
      `data:text/html,<div id="b" style="width:50px;height:50px;background:red;position:absolute;left:0"></div><div data-testid="done">done</div><script>let x=0;const b=document.getElementById('b');const t=setInterval(()=>{x+=20;b.style.left=x+'px';if(x>=120)clearInterval(t)},80)</script>`,
    );
    const step: FlowStep = {
      id: "s1",
      title: "wait for animation to settle",
      action: { type: "waitFor", locators: [{ kind: "testid", value: "done" }, { kind: "css", value: "[data-testid=done]" }], state: "visible" },
      settle: {
        strategy: "animationQuiescence",
        timeoutMs: 6000,
        quiescence: { sampleEveryMs: 200, stableFrames: 2, diffThresholdPct: 1 },
      },
      postConditions: [],
    } as FlowStep;
    const out = await runStepOnce(ctx(), step);
    expect(out.settleTimedOut).toBe(false);
    expect(out.settleMs).toBeGreaterThan(0);
  }, 15000);
});

describe("canvasClick vision grounding (doc 04 §3)", () => {
  const canvasPage = `data:text/html,<canvas data-testid="pack-canvas" width="300" height="200" style="width:300px;height:200px"></canvas>`;

  it("grounds the click when no point is recorded and confidence clears the gate", async () => {
    await page.goto(canvasPage);
    const step: FlowStep = {
      id: "s1",
      title: "rip via grounding",
      action: {
        type: "canvasClick",
        canvasLocator: [{ kind: "testid", value: "pack-canvas" }, { kind: "css", value: "canvas" }],
        point: null,
        visionFallback: { describe: "the glowing pack" },
      },
      settle: { strategy: "timeout", timeoutMs: 50 },
      postConditions: [],
    } as FlowStep;
    const out = await runStepOnce(ctx({ inference: groundingProvider({ nx: 0.5, ny: 0.5, confidence: 0.8 }) }), step);
    expect(out.failure).toBeNull();
  });

  it("low-confidence grounding → grounding_failed, no random click", async () => {
    await page.goto(canvasPage);
    const step: FlowStep = {
      id: "s1",
      title: "rip via grounding (low conf)",
      action: {
        type: "canvasClick",
        canvasLocator: [{ kind: "testid", value: "pack-canvas" }, { kind: "css", value: "canvas" }],
        point: null,
        visionFallback: { describe: "the glowing pack" },
      },
      settle: { strategy: "timeout", timeoutMs: 50 },
      postConditions: [],
    } as FlowStep;
    const out = await runStepOnce(ctx({ inference: groundingProvider({ nx: 0.5, ny: 0.5, confidence: 0.2 }) }), step);
    expect(out.failure?.failureClass).toBe("grounding_failed");
  });
});
