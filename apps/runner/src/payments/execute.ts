import type { Page } from "playwright";
import type { StepContext } from "../steps.js";
import type { PaymentProvider } from "./provider.js";
import { StripeProvider, STRIPE_3DS_TEST_CARDS } from "./stripe.js";

/**
 * The typed payment step (doc 02 §3, doc 07 §6). Order is non-negotiable:
 *   1. wait for the provider page/frame to arrive (the preceding step's
 *      click usually triggered the redirect)
 *   2. LIVE-MODE GUARD — positive confirmation of test mode, fail closed
 *   3. only then resolve card secrets and fill
 *   4. 3DS challenge when the variant (or a known-3DS card) asks for it
 */

export class PaymentUnverifiedError extends Error {
  constructor(detail: string) {
    super(`payment step skipped — could not verify test mode on this preview (${detail})`);
    this.name = "PaymentUnverifiedError";
  }
}

/** The provider gated checkout behind a CAPTCHA (doc 07 §7 — a v1 wall). */
export class PaymentCaptchaError extends Error {
  constructor() {
    super(
      "payment provider presented a CAPTCHA on checkout — FlowGuard never attempts to solve CAPTCHAs. " +
        "Use Stripe test keys with Radar/bot-protection disabled on preview deployments, or the non-3DS card variant.",
    );
    this.name = "PaymentCaptchaError";
  }
}

const PROVIDERS: Record<string, PaymentProvider> = {
  stripe: new StripeProvider(),
};

export function providerFor(name: string): PaymentProvider | null {
  return PROVIDERS[name] ?? null;
}

export interface PaymentAction {
  type: "payment";
  provider: string;
  variant: "card" | "card_3ds";
  configRef: string;
}

export async function executePaymentStep(ctx: StepContext, action: PaymentAction): Promise<void> {
  const provider = providerFor(action.provider);
  if (!provider) throw new Error(`payment provider "${action.provider}" lands in a later phase`);
  if (!ctx.payment) {
    throw new Error("payment step reached without a payment config — configure payments for this project");
  }
  if (!ctx.resolveRef) throw new Error("payment step requires a secret resolver");

  // 1. the redirect from the previous step may still be in flight
  await waitForProviderSurface(ctx.page, provider, 20_000);

  // 2. THE GUARD — before any secret is even resolved
  const verdict = await provider.detectTestMode(ctx.page);
  if (verdict !== true) {
    ctx.logger.warn(
      { provider: provider.name, verdict, url: ctx.page.url().split("?")[0] },
      "live-mode guard: test mode NOT confirmed — refusing to fill",
    );
    throw new PaymentUnverifiedError(
      verdict === false ? "LIVE-mode signals present" : "no test-mode signals found",
    );
  }
  ctx.logger.info({ provider: provider.name }, "live-mode guard: test mode confirmed");

  // 3. resolve + fill (plaintexts are redaction-registered by the resolver)
  const card = {
    number: (await ctx.resolveRef(ctx.payment.cardRef)).replace(/\s+/g, ""),
    expiry: ctx.payment.expiry,
    cvc: await ctx.resolveRef(ctx.payment.cvcRef),
  };
  await provider.fill(ctx.page, card);

  // 4. the challenge path (explicit variant OR a card known to trigger 3DS)
  if (action.variant === "card_3ds" || STRIPE_3DS_TEST_CARDS.has(card.number)) {
    await provider.handleChallenge(ctx.page);
  }

  // 5. return to the app: hosted checkout redirects provider → confirm → app in
  // several hops. The step is not done until the browser is back on the
  // deployment origin — otherwise the NEXT step runs mid-redirect on a
  // provider page and its locators all miss (learned live).
  await waitForReturnToApp(ctx.page, provider, ctx.baseUrl, 30_000);
}

async function waitForReturnToApp(page: Page, provider: PaymentProvider, _baseUrl: string, timeoutMs: number): Promise<void> {
  const onProvider = () => {
    const host = safeHost(page.url());
    return provider.frameAllowlist.some((h) => host === h || host.endsWith(`.${h}`));
  };
  // give the provider→confirm→app redirect chain a beat to start, then wait
  // until the main frame has LEFT the provider surface
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!onProvider()) {
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
      return;
    }
    await page.waitForTimeout(500);
  }
  // don't hard-fail: the payment step's post-conditions (e.g. a success-url
  // assertion) are the authority on whether the return actually happened
}

/** The payment surface: an allowlisted provider host, or a provider frame on the app page. */
async function waitForProviderSurface(page: Page, provider: PaymentProvider, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const host = safeHost(page.url());
    if (provider.frameAllowlist.some((h) => host === h || host.endsWith(`.${h}`))) return;
    for (const frame of page.frames()) {
      const fh = safeHost(frame.url());
      if (fh && provider.frameAllowlist.some((h) => fh === h || fh.endsWith(`.${h}`))) return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`payment step: no ${provider.name} checkout page or frame appeared within ${timeoutMs / 1000}s`);
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
