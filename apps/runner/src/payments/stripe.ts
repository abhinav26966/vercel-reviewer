import type { FrameLocator, Page } from "playwright";
import type { PaymentCard, PaymentProvider, TestModeVerdict } from "./provider.js";

/**
 * Stripe module (doc 07 §6): hosted Checkout first (the demo-app path —
 * `checkout.stripe.com` with `cs_test_…` session URLs, direct inputs), plus
 * best-effort embedded Elements via frameLocators on js.stripe.com frames.
 */

export const STRIPE_FRAME_ALLOWLIST = [
  "checkout.stripe.com",
  "js.stripe.com",
  "hooks.stripe.com",
  "pay.stripe.com",
  "m.stripe.network",
  "m.stripe.com",
];

/** Known-3DS test cards: the runner runs the challenge path even for variant "card". */
export const STRIPE_3DS_TEST_CARDS = new Set(["4000002760003155", "4000000000003220", "4000002500003155"]);

export class StripeProvider implements PaymentProvider {
  readonly name = "stripe";
  readonly frameAllowlist = STRIPE_FRAME_ALLOWLIST;

  /**
   * Positive confirmation of test mode, live signals checked FIRST (a page
   * carrying both is treated as live → fail closed):
   *   cs_live_/pk_live_ anywhere → false
   *   cs_test_ in the URL, pk_test_ in page context, or the Checkout
   *   test-mode badge → true
   *   nothing recognizable → null (⇒ payment_unverified_env)
   */
  async detectTestMode(page: Page): Promise<TestModeVerdict> {
    const url = page.url();
    if (/cs_live_|pk_live_/.test(url)) return false;
    const html = await page.content().catch(() => "");
    if (/pk_live_|cs_live_/.test(html)) return false;
    if (/cs_test_/.test(url)) return true;
    if (/pk_test_|cs_test_/.test(html)) return true;
    const badge = await page
      .getByText(/test mode/i)
      .count()
      .catch(() => 0);
    if (badge > 0) return true;
    return null;
  }

  async fill(page: Page, card: PaymentCard): Promise<void> {
    const scope = await this.formScope(page);
    const field = async (selectors: string[], value: string, required: boolean) => {
      for (const sel of selectors) {
        const loc = scope.locator(sel).first();
        if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
          if ((await loc.inputValue().catch(() => "x")) === "") await loc.fill(value);
          return true;
        }
      }
      if (required) throw new Error(`stripe: no fillable field for ${selectors[0]}`);
      return false;
    };

    await field(['[name="cardNumber"]', "#cardNumber", '[placeholder*="1234"]'], card.number, true);
    await field(['[name="cardExpiry"]', "#cardExpiry", '[placeholder*="MM"]'], card.expiry, true);
    await field(['[name="cardCvc"]', "#cardCvc", '[placeholder*="CVC"]'], card.cvc, true);
    await field(['[name="billingName"]', "#billingName"], "FlowGuard Test", false);
    await field(['[name="email"]:not([readonly])'], "test@flowguard.dev", false);
    await field(['[name="billingPostalCode"]', "#billingPostalCode"], "42424", false);

    const submit = scope.locator('button[type="submit"], .SubmitButton').first();
    await submit.click({ timeout: 10_000 });
  }

  /**
   * The test 3DS modal: a challenge frame with a "Complete/Authorize" button
   * (`#test-source-authorize-3ds` on older flows). Frames nest unpredictably —
   * poll every frame on an allowlisted Stripe host.
   */
  async handleChallenge(page: Page): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      for (const frame of page.frames()) {
        let host = "";
        try {
          host = new URL(frame.url()).host;
        } catch {
          continue;
        }
        if (!this.frameAllowlist.some((h) => host === h || host.endsWith(`.${h}`))) continue;
        const button = frame
          .locator('#test-source-authorize-3ds, button:has-text("Complete authentication"), button:has-text("Complete"), button:has-text("Authorize Test Payment")')
          .first();
        if ((await button.count().catch(() => 0)) > 0 && (await button.isVisible().catch(() => false))) {
          await button.click({ timeout: 5000 }).catch(() => {});
          return;
        }
      }
      await page.waitForTimeout(1000);
    }
    throw new Error("stripe: 3DS challenge frame never presented a completion button");
  }

  /** Hosted Checkout = direct page inputs; embedded Elements = js.stripe.com frame. */
  private async formScope(page: Page): Promise<Page | FrameLocator> {
    const direct = await page
      .locator('[name="cardNumber"], #cardNumber')
      .count()
      .catch(() => 0);
    if (direct > 0) return page;
    return page.frameLocator('iframe[src*="js.stripe.com"]');
  }
}
