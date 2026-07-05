import { describe, expect, it } from "vitest";
import { RedactionRegistry } from "../src/redaction.js";
import { createLogger } from "../src/logger.js";

describe("RedactionRegistry", () => {
  it("scrubs registered secrets from strings", () => {
    const r = new RedactionRegistry();
    r.register("hunter2secret");
    expect(r.redactString("password is hunter2secret!")).toBe("password is «redacted»!");
  });

  it("ignores too-short secrets", () => {
    const r = new RedactionRegistry();
    r.register("ab");
    expect(r.redactString("ab")).toBe("ab");
  });

  it("scrubs deeply nested values and arrays", () => {
    const r = new RedactionRegistry();
    r.register("s3cr3tvalue");
    const scrubbed = r.redactDeep({
      a: "s3cr3tvalue",
      b: { c: ["x", "prefix s3cr3tvalue suffix"] },
      d: 42,
    });
    expect(scrubbed).toEqual({
      a: "«redacted»",
      b: { c: ["x", "prefix «redacted» suffix"] },
      d: 42,
    });
  });

  it("handles cyclic objects without throwing", () => {
    const r = new RedactionRegistry();
    r.register("s3cr3tvalue");
    const obj: Record<string, unknown> = { a: "s3cr3tvalue" };
    obj.self = obj;
    expect(() => r.redactDeep(obj)).not.toThrow();
  });
});

describe("createLogger redaction", () => {
  it("never emits a registered secret in any log byte", () => {
    const registry = new RedactionRegistry();
    registry.register("tOpSeCrEtPw99");
    const lines: string[] = [];
    const logger = createLogger({
      name: "test",
      redaction: registry,
      destination: {
        write(msg: string) {
          lines.push(msg);
        },
      },
    });
    logger.info({ password: "tOpSeCrEtPw99", nested: { v: "xx tOpSeCrEtPw99 yy" } }, "login with tOpSeCrEtPw99");
    logger.error("interpolated %s", "tOpSeCrEtPw99");
    const all = lines.join("\n");
    expect(all).not.toContain("tOpSeCrEtPw99");
    expect(all).toContain("«redacted»");
  });
});
