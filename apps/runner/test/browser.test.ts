import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { LocatorMissError, resolveLocator } from "../src/pw-locators.js";
import { evalAssertion, evalUrlAssertion } from "../src/assertions.js";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.setContent(`
    <nav><span data-testid="session-email">default@demo.dev</span></nav>
    <main>
      <h1>Inventory</h1>
      <button data-testid="buy-pack-btn">Buy Pack</button>
      <div data-testid="pack-card">pack 1</div>
      <div data-testid="pack-card">pack 2</div>
      <input type="email" placeholder="Email" />
      <button disabled data-testid="disabled-btn">Nope</button>
    </main>
  `);
});

afterAll(async () => {
  await browser?.close();
});

describe("resolveLocator", () => {
  it("resolves the first matching locator in the stack", async () => {
    const loc = await resolveLocator(page, [
      { kind: "testid", value: "buy-pack-btn" },
      { kind: "css", value: "button" },
    ]);
    expect(await loc.textContent()).toBe("Buy Pack");
  });

  it("falls through dead locators to later ones", async () => {
    const loc = await resolveLocator(page, [
      { kind: "testid", value: "does-not-exist" },
      { kind: "role", value: { role: "button", name: "Buy Pack" } },
    ]);
    expect(await loc.textContent()).toBe("Buy Pack");
  });

  it("throws LocatorMissError when nothing matches within budget", async () => {
    await expect(
      resolveLocator(page, [
        { kind: "testid", value: "ghost-1" },
        { kind: "css", value: "#ghost-2" },
      ]),
    ).rejects.toBeInstanceOf(LocatorMissError);
  }, 15000);
});

describe("dom assertions", () => {
  it("visible / hidden semantics (hidden passes on absent elements)", async () => {
    expect(
      (await evalAssertion(page, {
        kind: "dom",
        assert: "visible",
        locators: [{ kind: "testid", value: "session-email" }],
      })).pass,
    ).toBe(true);
    expect(
      (await evalAssertion(page, {
        kind: "dom",
        assert: "hidden",
        locators: [{ kind: "testid", value: "open-error" }],
      })).pass,
    ).toBe(true);
    expect(
      (await evalAssertion(page, {
        kind: "dom",
        assert: "hidden",
        locators: [{ kind: "testid", value: "session-email" }],
      })).pass,
    ).toBe(false);
  });

  it("textMatches, countEquals, enabled", async () => {
    expect(
      (await evalAssertion(page, {
        kind: "dom",
        assert: "textMatches",
        locators: [{ kind: "css", value: "main h1" }],
        value: "^Inventory$",
      })).pass,
    ).toBe(true);
    expect(
      (await evalAssertion(page, {
        kind: "dom",
        assert: "countEquals",
        locators: [{ kind: "testid", value: "pack-card" }],
        value: 2,
      })).pass,
    ).toBe(true);
    const disabled = await evalAssertion(page, {
      kind: "dom",
      assert: "enabled",
      locators: [{ kind: "testid", value: "disabled-btn" }],
    });
    expect(disabled.pass).toBe(false);
    expect(disabled.message).toContain("disabled");
  });

  it("assertion locator stacks fall through like action stacks", async () => {
    expect(
      (await evalAssertion(page, {
        kind: "dom",
        assert: "visible",
        locators: [
          { kind: "testid", value: "ghost" },
          { kind: "css", value: "main h1" },
        ],
      })).pass,
    ).toBe(true);
  });

  it("unsupported kinds report their phase instead of crashing", async () => {
    const r = await evalAssertion(page, {
      kind: "vision",
      question: "how many cards?",
      assert: "equals",
      value: 5,
    });
    expect(r.pass).toBe(false);
    expect(r.message).toContain("later phase");
  });
});

describe("evalUrlAssertion (pure)", () => {
  const url = "https://demo-abc.vercel.app/shop/success?x=1";
  it("pathMatches with regex", () => {
    expect(evalUrlAssertion(url, { kind: "url", assert: "pathMatches", value: "^/shop/success$" }).pass).toBe(true);
    expect(evalUrlAssertion(url, { kind: "url", assert: "pathMatches", value: "^/inventory$" }).pass).toBe(false);
  });
  it("equals compares path for /-prefixed values, full URL otherwise", () => {
    expect(evalUrlAssertion(url, { kind: "url", assert: "equals", value: "/shop/success" }).pass).toBe(true);
    expect(evalUrlAssertion(url, { kind: "url", assert: "equals", value: url }).pass).toBe(true);
    expect(evalUrlAssertion(url, { kind: "url", assert: "equals", value: "/shop" }).pass).toBe(false);
  });
});
