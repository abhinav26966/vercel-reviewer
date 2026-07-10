import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { executePaymentStep, PaymentUnverifiedError } from "../src/payments/execute.js";
import { StripeProvider, STRIPE_3DS_TEST_CARDS } from "../src/payments/stripe.js";
import { NetworkTracker } from "../src/network-tracker.js";
import type { StepContext } from "../src/steps.js";

let browser: Browser;
let page: Page;
const stripe = new StripeProvider();

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});

afterAll(async () => {
  await browser?.close();
});

function ctx(over: Partial<StepContext> = {}): StepContext {
  return {
    page,
    baseUrl: "data:text/html,x",
    tracker: new NetworkTracker(),
    logger: pino({ level: "silent" }),
    payment: { provider: "stripe", cardRef: "sec_card", expiry: "12 / 34", cvcRef: "sec_cvc" },
    resolveRef: async (ref) => (ref === "sec_card" ? "4242424242424242" : "123"),
    ...over,
  };
}

const CHECKOUT_FORM = `
<input name="cardNumber" placeholder="1234 1234 1234 1234" />
<input name="cardExpiry" placeholder="MM / YY" />
<input name="cardCvc" placeholder="CVC" />
<input name="billingName" />
<button type="submit">Pay</button>`;

describe("StripeProvider.detectTestMode — the live-mode guard (doc 07 §6)", () => {
  it("pk_test_ in page context → test mode confirmed", async () => {
    await page.goto(`data:text/html,<script>var k="pk_test_abc123"</script><p>checkout</p>`);
    expect(await stripe.detectTestMode(page)).toBe(true);
  });

  it("the Checkout test-mode badge → confirmed", async () => {
    await page.goto(`data:text/html,<div><span>TEST MODE</span>${CHECKOUT_FORM}</div>`);
    expect(await stripe.detectTestMode(page)).toBe(true);
  });

  it("pk_live_ anywhere → LIVE, even when test signals coexist (live wins)", async () => {
    await page.goto(`data:text/html,<script>var a="pk_live_x",b="pk_test_y"</script>`);
    expect(await stripe.detectTestMode(page)).toBe(false);
  });

  it("no recognizable signals → null (fail closed upstream)", async () => {
    await page.goto(`data:text/html,<p>A checkout page with no stripe markers</p>${CHECKOUT_FORM}`);
    expect(await stripe.detectTestMode(page)).toBe(null);
  });
});

describe("executePaymentStep — guard order is non-negotiable", () => {
  const action = { type: "payment" as const, provider: "stripe", variant: "card" as const, configRef: "project" };

  it("unverifiable page → PaymentUnverifiedError, NOTHING filled, secrets never resolved", async () => {
    // page has stripe-frame markers so the surface wait passes, but no test signals
    await page.goto(
      `data:text/html,<iframe src="https://js.stripe.com/v3/frame.html" style="display:none"></iframe>${CHECKOUT_FORM}`,
    );
    let secretsResolved = 0;
    const c = ctx({
      resolveRef: async (ref) => {
        secretsResolved++;
        return ref;
      },
    });
    await expect(executePaymentStep(c, action)).rejects.toThrow(PaymentUnverifiedError);
    expect(secretsResolved).toBe(0); // the guard fires BEFORE secret resolution
    expect(await page.locator('[name="cardNumber"]').inputValue()).toBe("");
  });

  it("LIVE signals → refused with the live-mode message", async () => {
    await page.goto(
      `data:text/html,<iframe src="https://js.stripe.com/v3/f.html" style="display:none"></iframe><script>var k="pk_live_abc"</script>${CHECKOUT_FORM}`,
    );
    await expect(executePaymentStep(ctx(), action)).rejects.toThrow(/LIVE-mode signals/);
  });

  it("test mode confirmed → fills the hosted-checkout form and submits", async () => {
    await page.goto(
      `data:text/html,<iframe src="https://js.stripe.com/v3/f.html" style="display:none"></iframe><script>var k="pk_test_abc"</script>${CHECKOUT_FORM}<div id="paid" style="display:none">paid</div><script>document.querySelector("button").addEventListener("click",function(e){e.preventDefault();document.getElementById("paid").style.display="block"})</script>`,
    );
    await executePaymentStep(ctx(), action);
    expect(await page.locator('[name="cardNumber"]').inputValue()).toBe("4242424242424242");
    expect(await page.locator('[name="cardExpiry"]').inputValue()).toBe("12 / 34");
    expect(await page.locator('[name="cardCvc"]').inputValue()).toBe("123");
    expect(await page.locator("#paid").isVisible()).toBe(true);
  });

  it("no payment config → hard error naming the consent gate", async () => {
    await page.goto(`data:text/html,${CHECKOUT_FORM}`);
    await expect(executePaymentStep(ctx({ payment: null }), action)).rejects.toThrow(/configure payments/);
  });

  it("no provider surface ever appears → times out with a named error", async () => {
    await page.goto(`data:text/html,<p>the app page, no redirect happened</p>`);
    const c = ctx();
    await expect(
      (async () => {
        const { executePaymentStep: run } = await import("../src/payments/execute.js");
        // shrink the wait by racing: the surface wait is 20s — use a tight page instead
        return run(c, action);
      })(),
    ).rejects.toThrow(/no stripe checkout page or frame/i);
  }, 30_000);
});

describe("3DS test-card set", () => {
  it("contains the documented challenge cards", () => {
    expect(STRIPE_3DS_TEST_CARDS.has("4000002760003155")).toBe(true);
    expect(STRIPE_3DS_TEST_CARDS.has("4242424242424242")).toBe(false);
  });
});
