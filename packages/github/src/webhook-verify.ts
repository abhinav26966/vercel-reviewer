import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * GitHub webhook signature verification (X-Hub-Signature-256).
 * Constant-time compare; verified against the RAW request body before parsing.
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const given = signatureHeader.slice("sha256=".length);
  if (given.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}
