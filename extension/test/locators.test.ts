import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import type * as LocatorsMod from "../src/locators.js";
import type * as RedactMod from "../src/redact.js";

type FGWindow = { FG: typeof LocatorsMod & typeof RedactMod };
import type { Browser, Page } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";

/**
 * The locator/redaction modules run inside recorded pages — test them in a real
 * chromium page by bundling and injecting them.
 */
let browser: Browser;
let page: Page;
let bundle: string;

beforeAll(async () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const out = path.join(dir, ".locators-bundle.js");
  await build({
    stdin: {
      contents: `export * from "../src/locators.ts"; export * from "../src/redact.ts";`,
      resolveDir: dir,
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    globalName: "FG",
    outfile: out,
  });
  bundle = await readFile(out, "utf8");
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.setContent(`
    <main>
      <button data-testid="buy-pack-btn">Buy Pack</button>
      <label for="em">Email</label><input id="em" type="email" placeholder="Email" />
      <input type="password" data-testid="password-input" placeholder="Password" />
      <input name="card_number" value="4242" />
      <div class="wrap"><canvas data-testid="pack-canvas" width="200" height="100"></canvas></div>
      <a href="/shop">Shop</a>
    </main>
  `);
  await page.addScriptTag({ content: bundle });
});

afterAll(async () => {
  await browser?.close();
});

describe("computeLocators", () => {
  it("button: testid → role+name → text → css, ≥2 locators", async () => {
    const locators = await page.evaluate(() =>
      (window as never as FGWindow).FG.computeLocators(
        document.querySelector('[data-testid="buy-pack-btn"]')!,
      ),
    );
    expect(locators.length).toBeGreaterThanOrEqual(2);
    expect(locators[0]).toEqual({ kind: "testid", value: "buy-pack-btn" });
    expect(locators).toContainEqual({ kind: "role", value: { role: "button", name: "Buy Pack" } });
    expect(locators).toContainEqual({ kind: "text", value: "Buy Pack" });
    expect(locators.at(-1)!.kind).toBe("css");
    expect(locators.some((l) => (l as { kind: string }).kind === "xpath")).toBe(false);
  });

  it("labelled input gets role textbox with the label name + placeholder", async () => {
    const locators = await page.evaluate(() =>
      (window as never as FGWindow).FG.computeLocators(
        document.getElementById("em")!,
      ),
    );
    expect(locators).toContainEqual({ kind: "role", value: { role: "textbox", name: "Email" } });
    expect(locators).toContainEqual({ kind: "placeholder", value: "Email" });
  });

  it("canvas clicks carry normalized coordinates", async () => {
    const info = await page.evaluate(() => {
      const canvas = document.querySelector("canvas")!;
      const rect = canvas.getBoundingClientRect();
      return (window as never as FGWindow).FG.canvasInfo(
        canvas,
        rect.left + rect.width * 0.5,
        rect.top + rect.height * 0.62,
      );
    });
    expect(info.isCanvas).toBe(true);
    expect(info.canvasRelative!.nx).toBeCloseTo(0.5, 2);
    expect(info.canvasRelative!.ny).toBeCloseTo(0.62, 2);
  });

  it("non-canvas elements report isCanvas false", async () => {
    const info = await page.evaluate(() =>
      (window as never as FGWindow).FG.canvasInfo(
        document.querySelector("a")!,
        0,
        0,
      ),
    );
    expect(info).toEqual({ isCanvas: false, canvasRelative: null });
  });
});

describe("redactInputValue", () => {
  it("password inputs → «redacted:password», secret-pattern fields → «redacted:secret»", async () => {
    const results = await page.evaluate(() => {
      const FG = (window as never as FGWindow).FG;
      return {
        password: FG.redactInputValue(document.querySelector('[type="password"]')!, "demo1234"),
        card: FG.redactInputValue(document.querySelector('[name="card_number"]')!, "4242424242424242"),
        email: FG.redactInputValue(document.getElementById("em")!, "a@b.dev"),
      };
    });
    expect(results.password).toBe("«redacted:password»");
    expect(results.card).toBe("«redacted:secret»");
    expect(results.email).toBe("a@b.dev");
  });
});
