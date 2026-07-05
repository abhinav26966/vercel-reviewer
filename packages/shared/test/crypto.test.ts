import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, parseMasterKey } from "../src/crypto.js";

const master = parseMasterKey("a".repeat(64));

describe("envelope encryption", () => {
  it("round-trips a secret", () => {
    const enc = encryptSecret("hunter2-super-secret", master);
    expect(decryptSecret(enc, master)).toBe("hunter2-super-secret");
    expect(enc.kmsKeyId).toBe("local:v1");
  });

  it("produces unique ciphertexts for the same plaintext (fresh DEK + IV)", () => {
    const a = encryptSecret("same", master);
    const b = encryptSecret("same", master);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.dekWrapped.equals(b.dekWrapped)).toBe(false);
  });

  it("fails closed on tampered ciphertext", () => {
    const enc = encryptSecret("secret", master);
    enc.ciphertext[enc.ciphertext.length - 1]! ^= 0xff;
    expect(() => decryptSecret(enc, master)).toThrow();
  });

  it("fails closed with the wrong master key", () => {
    const enc = encryptSecret("secret", master);
    expect(() => decryptSecret(enc, parseMasterKey("b".repeat(64)))).toThrow();
  });

  it("rejects malformed master keys", () => {
    expect(() => parseMasterKey("too-short")).toThrow();
  });
});
