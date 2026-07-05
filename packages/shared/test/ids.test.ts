import { describe, expect, it } from "vitest";
import { ID_PREFIXES, idKindOf, newId } from "../src/ids.js";

describe("newId", () => {
  it("generates prefixed ids for every kind", () => {
    for (const kind of Object.keys(ID_PREFIXES) as (keyof typeof ID_PREFIXES)[]) {
      const id = newId(kind);
      expect(id).toMatch(new RegExp(`^${ID_PREFIXES[kind]}_[0-9a-z]{14}$`));
    }
  });

  it("generates unique ids", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId("run")));
    expect(ids.size).toBe(1000);
  });

  it("round-trips kind detection", () => {
    expect(idKindOf(newId("project"))).toBe("project");
    expect(idKindOf("bogus_abc")).toBeNull();
  });
});
