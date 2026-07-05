import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "../src/webhook-verify.js";

const SECRET = "wh_secret";
const sign = (body: string) =>
  `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

describe("verifyWebhookSignature", () => {
  it("accepts a valid signature", () => {
    const body = JSON.stringify({ action: "opened" });
    expect(verifyWebhookSignature(SECRET, body, sign(body))).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify({ action: "opened" });
    expect(verifyWebhookSignature(SECRET, body + " ", sign(body))).toBe(false);
  });

  it("rejects a signature from the wrong secret", () => {
    const body = "{}";
    const wrong = `sha256=${createHmac("sha256", "other").update(body).digest("hex")}`;
    expect(verifyWebhookSignature(SECRET, body, wrong)).toBe(false);
  });

  it("rejects missing/malformed headers", () => {
    expect(verifyWebhookSignature(SECRET, "{}", undefined)).toBe(false);
    expect(verifyWebhookSignature(SECRET, "{}", "sha1=abc")).toBe(false);
    expect(verifyWebhookSignature(SECRET, "{}", "sha256=nothex")).toBe(false);
  });
});
