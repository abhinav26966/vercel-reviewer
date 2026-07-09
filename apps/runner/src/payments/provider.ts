import type { Page } from "playwright";

/**
 * PaymentProvider (doc 07 §6): Stripe first; PayPal sandbox / Razorpay test
 * as future modules. The runner drives the provider NATIVELY — recorded
 * iframe internals are never needed (cross-origin frames are opaque to the
 * recorder anyway).
 */

export interface PaymentCard {
  /** Plaintext at fill time only — resolved from secret refs, redaction-registered. */
  number: string;
  expiry: string;
  cvc: string;
}

/** true = test mode confirmed; false = LIVE signals found; null = cannot confirm. */
export type TestModeVerdict = boolean | null;

export interface PaymentProvider {
  readonly name: string;
  /** Navigation to these hosts is allowed through the origin guard. */
  readonly frameAllowlist: string[];
  /**
   * The live-mode guard (doc 07 §6) — mandatory, independent of user config,
   * FAIL CLOSED: the runner fills nothing unless this returns true.
   */
  detectTestMode(page: Page): Promise<TestModeVerdict>;
  /** Fill card fields + submit. Throws on unfillable forms. */
  fill(page: Page, card: PaymentCard): Promise<void>;
  /** Complete the provider's test 3DS/SCA challenge (variant card_3ds). */
  handleChallenge(page: Page): Promise<void>;
}
