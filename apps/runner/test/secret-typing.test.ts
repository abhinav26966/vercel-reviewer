import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { NetworkTracker } from "../src/network-tracker.js";
import { runStepOnce, type StepContext } from "../src/steps.js";
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

function ctx(baseUrl: string, secrets: Record<string, string> = {}): StepContext {
  const tracker = new NetworkTracker();
  return {
    page,
    baseUrl,
    tracker,
    logger: pino({ level: "silent" }),
    lookupSecret: async (name) => {
      const v = secrets[name];
      if (!v) throw new Error(`no secret ${name}`);
      return v;
    },
  };
}

const typeStep = (value: string): FlowStep => ({
  id: "s1",
  title: "type secret",
  action: {
    type: "type",
    locators: [
      { kind: "testid", value: "password-input" },
      { kind: "css", value: "input[type=password]" },
    ],
    value,
  },
  settle: { strategy: "timeout", timeoutMs: 50 },
  postConditions: [],
});

describe("secret typing via CDP", () => {
  it("substitutes placeholders at keystroke time and fills the field", async () => {
    // page.setContent leaves url about:blank; give it a real-ish origin via data URL route
    await page.goto("data:text/html,<input type=password data-testid=password-input />");
    const c = ctx("data:text/html,<input type=password data-testid=password-input />");
    // data: URLs have no host — both page and base resolve to empty host, guard passes
    c.lookupSecret = async () => "s3cr3t-pw";
    const failure = await runStepOnce(c, typeStep("{{secret:default.password}}"));
    expect(failure).toBeNull();
    expect(await page.locator("input").inputValue()).toBe("s3cr3t-pw");
  });

  it("refuses to type secrets into a different origin (fail closed)", async () => {
    await page.goto("data:text/html,<input type=password data-testid=password-input />");
    const c = ctx("https://the-real-deployment.vercel.app", { "default.password": "s3cr3t-pw" });
    const failure = await runStepOnce(c, typeStep("{{secret:default.password}}"));
    expect(failure).not.toBeNull();
    expect(failure!.failureClass).toBe("env");
    expect(failure!.message).toContain("refusing to type a secret");
  });

  it("fails closed when no secret resolver is available", async () => {
    await page.goto("data:text/html,<input type=password data-testid=password-input />");
    const c = ctx("data:text/html,x");
    delete (c as Partial<StepContext>).lookupSecret;
    const failure = await runStepOnce(c, typeStep("{{secret:default.password}}"));
    expect(failure).not.toBeNull();
    expect(failure!.message).toContain("no credentials");
  });

  it("plain values still use ordinary fill", async () => {
    await page.goto("data:text/html,<input type=password data-testid=password-input />");
    const failure = await runStepOnce(ctx("data:text/html,x"), typeStep("plain-value"));
    expect(failure).toBeNull();
    expect(await page.locator("input").inputValue()).toBe("plain-value");
  });
});
