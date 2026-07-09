import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import type { InferenceProvider } from "@flowguard/inference";
import { healStep } from "../src/heal.js";
import { NetworkTracker } from "../src/network-tracker.js";
import type { StepContext } from "../src/steps.js";
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

const logger = pino({ level: "silent" });

function ctx(): StepContext {
  return { page, baseUrl: "data:text/html,x", tracker: new NetworkTracker(), logger };
}

/** A provider that plays back scripted actions, one per turn. */
function scriptedProvider(actions: unknown[]): InferenceProvider {
  let i = 0;
  return {
    visionAnalyze: async <T,>() => ({ result: actions[Math.min(i++, actions.length - 1)] as T, usage: { model: "fake", promptTokens: 0, completionTokens: 0 } }),
    judge: async () => {
      throw new Error("not used");
    },
    groundElement: async () => ({ result: null, usage: { model: "fake", promptTokens: 0, completionTokens: 0 } }),
  } as InferenceProvider;
}

const RENAMED_PAGE = `data:text/html,
<button data-testid="get-pack-btn" onclick="document.getElementById('done').style.display='block'">Get Pack</button>
<div id="done" data-testid="done" style="display:none">purchased</div>`;

const clickStep: FlowStep = {
  id: "s1",
  title: "Click Buy Pack",
  action: { type: "click", locators: [{ kind: "testid", value: "buy-pack-btn" }] },
  settle: { strategy: "timeout", timeoutMs: 50 },
  postConditions: [
    { kind: "dom", assert: "visible", locators: [{ kind: "testid", value: "done" }] },
  ],
} as FlowStep;

describe("healStep (doc 04 §5)", () => {
  it("finds the renamed element, passes post-conditions, proposes a locator patch", async () => {
    await page.goto(RENAMED_PAGE);
    const heal = await healStep(
      ctx(),
      clickStep,
      scriptedProvider([
        { action: "click", locator: { kind: "testid", value: "get-pack-btn" }, reason: "button renamed" },
      ]),
      logger,
    );
    expect(heal.succeeded).toBe(true);
    expect(heal.proposedPatch).toMatchObject({ stepId: "s1" });
    const locators = heal.proposedPatch!.locators as Array<{ value: unknown }>;
    expect(locators[0]).toMatchObject({ kind: "testid", value: "get-pack-btn" });
    expect(locators.at(-1)).toMatchObject({ value: "buy-pack-btn" }); // original kept as fallback
  });

  it("giveup ends the loop as a failure with the original failure standing", async () => {
    await page.goto(RENAMED_PAGE);
    const heal = await healStep(
      ctx(),
      clickStep,
      scriptedProvider([{ action: "giveup", reason: "element genuinely gone" }]),
      logger,
    );
    expect(heal.succeeded).toBe(false);
    expect(heal.transcript.join("\n")).toContain("giveup");
  });

  it("fails closed on secret-typing steps without calling the model", async () => {
    const secretStep: FlowStep = {
      ...clickStep,
      action: {
        type: "type",
        locators: [{ kind: "css", value: "input" }],
        value: "{{secret:default.password}}",
      },
    } as FlowStep;
    let called = false;
    const provider = {
      visionAnalyze: async () => {
        called = true;
        throw new Error("must not be called");
      },
    } as unknown as InferenceProvider;
    const heal = await healStep(ctx(), secretStep, provider, logger);
    expect(heal.succeeded).toBe(false);
    expect(called).toBe(false);
    expect(heal.transcript[0]).toContain("secret");
  });

  it("refuses model actions that reference secrets", async () => {
    await page.goto(`data:text/html,<input /><div data-testid="done" style="display:none"></div>`);
    const heal = await healStep(
      ctx(),
      clickStep,
      scriptedProvider([
        { action: "type", locator: { kind: "css", value: "input" }, value: "{{secret:default.password}}", reason: "logging in" },
      ]),
      logger,
    );
    expect(heal.succeeded).toBe(false);
    expect(heal.transcript.join("\n")).toContain("refused");
  });

  it("gives up after the action budget", async () => {
    await page.goto(`data:text/html,<p>nothing useful</p>`);
    const heal = await healStep(
      ctx(),
      clickStep,
      scriptedProvider([{ action: "scroll", reason: "looking around" }]),
      logger,
    );
    expect(heal.succeeded).toBe(false);
    // 6 scroll turns, no post-condition ever passes
    expect(heal.transcript.filter((t) => t.includes("scroll"))).toHaveLength(6);
  });
});
