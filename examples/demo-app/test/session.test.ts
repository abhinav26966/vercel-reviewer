import { describe, expect, it } from "vitest";
import { decodeSession, encodeSession } from "../src/lib/session";

describe("session cookie signing", () => {
  const secret = "test-secret";

  it("round-trips a session", () => {
    const token = encodeSession({ email: "default@demo.dev", packs: 3 }, secret);
    expect(decodeSession(token, secret)).toEqual({ email: "default@demo.dev", packs: 3 });
  });

  it("rejects a tampered payload", () => {
    const token = encodeSession({ email: "default@demo.dev", packs: 3 }, secret);
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ email: "default@demo.dev", packs: 999 })).toString(
      "base64url",
    );
    expect(decodeSession(`${forged}.${sig}`, secret)).toBeNull();
    expect(decodeSession(`${payload}.${sig}x`, secret)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const token = encodeSession({ email: "default@demo.dev", packs: 3 }, "other-secret");
    expect(decodeSession(token, secret)).toBeNull();
  });

  it("rejects garbage", () => {
    expect(decodeSession("not-a-token", secret)).toBeNull();
    expect(decodeSession("", secret)).toBeNull();
  });
});
