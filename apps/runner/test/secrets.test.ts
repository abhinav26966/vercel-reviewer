import { describe, expect, it } from "vitest";
import { globalRedaction } from "@flowguard/shared";
import { findSecretPlaceholders, specUsesSecrets, StaticSecretResolver } from "../src/secrets.js";
import { redactHarObject } from "../src/har-redact.js";
import { RedactionRegistry } from "@flowguard/shared";

describe("secret placeholders", () => {
  it("finds placeholders", () => {
    expect(findSecretPlaceholders("{{secret:default.password}}")).toEqual(["default.password"]);
    expect(findSecretPlaceholders("plain value")).toEqual([]);
    expect(findSecretPlaceholders("{{secret:a.b}} and {{secret:c.d}}")).toEqual(["a.b", "c.d"]);
  });

  it("detects secret-using specs (disables tracing)", () => {
    const mk = (value: string) => ({
      steps: [{ action: { type: "type", value } }, { action: { type: "click" } }],
    });
    expect(specUsesSecrets(mk("{{secret:default.password}}"))).toBe(true);
    expect(specUsesSecrets(mk("hello"))).toBe(false);
  });

  it("StaticSecretResolver registers plaintext with the redaction registry", async () => {
    const r = new StaticSecretResolver({ sec_1: "sup3rs3cret" });
    await r.resolve("sec_1");
    expect(globalRedaction.redactString("x sup3rs3cret y")).toBe("x «redacted» y");
    await expect(r.resolve("sec_missing")).rejects.toThrow("not found");
  });
});

describe("HAR redaction", () => {
  it("strips bodies on sensitive endpoints, cookies/auth headers, and registered secrets", () => {
    const registry = new RedactionRegistry();
    registry.register("hunter2secret");
    const har = {
      log: {
        entries: [
          {
            request: {
              url: "https://app.dev/api/login",
              postData: { text: "email=a@b.c&password=hunter2secret" },
              headers: [
                { name: "Cookie", value: "session=abc" },
                { name: "content-type", value: "application/x-www-form-urlencoded" },
              ],
            },
          },
          {
            request: {
              url: "https://app.dev/api/packs/buy",
              postData: { text: "qty=1 token hunter2secret" },
              headers: [{ name: "Authorization", value: "Bearer xyz" }],
            },
          },
        ],
      },
    };
    const out = redactHarObject(har, registry);
    const text = JSON.stringify(out);
    expect(text).not.toContain("hunter2secret");
    expect(out.log!.entries![0]!.request!.postData).toEqual({ text: "«stripped:sensitive-endpoint»" });
    expect(out.log!.entries![0]!.request!.headers![0]!.value).toBe("«stripped»");
    expect(out.log!.entries![1]!.request!.headers![0]!.value).toBe("«stripped»");
    // non-sensitive endpoint keeps its (redacted) body
    expect(out.log!.entries![1]!.request!.postData!.text).toContain("«redacted»");
  });
});
