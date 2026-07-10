/**
 * Test-card soft validation (doc 07 §6): entered card not in the recognized
 * provider test sets → hard warning + double confirm. People paste real cards
 * more often than you'd hope.
 */

/** Stripe's documented test cards (number-only membership check). */
const STRIPE_TEST_CARDS = new Set([
  "4242424242424242", // visa
  "4000056655665556", // visa debit
  "5555555555554444", // mastercard
  "2223003122003222", // mastercard 2-series
  "5200828282828210", // mastercard debit
  "5105105105105100", // mastercard prepaid
  "378282246310005", // amex
  "371449635398431", // amex
  "6011111111111117", // discover
  "3056930009020004", // diners
  "36227206271667", // diners 14-digit
  "3566002020360505", // jcb
  "6200000000000005", // unionpay
  "4000002760003155", // 3DS required
  "4000000000003220", // 3DS2 required
  "4000002500003155", // 3DS setup
  "4000000000009995", // insufficient funds decline
  "4000000000009987", // lost card decline
  "4000000000000002", // generic decline
  "4000000000000069", // expired card decline
  "4000000000000127", // incorrect cvc decline
  "4000000000000119", // processing error
]);

export function normalizeCardNumber(card: string): string {
  return card.replace(/[\s-]/g, "");
}

export function isRecognizedTestCard(card: string, provider: string): boolean {
  if (provider !== "stripe") return false; // other providers land with their modules
  return STRIPE_TEST_CARDS.has(normalizeCardNumber(card));
}

export const UNRECOGNIZED_CARD_WARNING =
  "this doesn't look like a known test card — if it's a real card, remove it now";
