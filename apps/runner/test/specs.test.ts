import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FlowSpecSchema } from "@flowguard/schemas";

const flowsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "flows");

describe("handwritten flow specs", () => {
  for (const name of ["login", "inventory", "rip", "rip-broken"]) {
    it(`${name}.flow.json validates against FlowSpecSchema`, async () => {
      const raw = JSON.parse(await readFile(path.join(flowsDir, `${name}.flow.json`), "utf8"));
      const spec = FlowSpecSchema.parse(raw);
      expect(spec.steps.length).toBeGreaterThan(0);
      // every DOM action carries ≥2 locators (doc 02 §3)
      for (const step of spec.steps) {
        if ("locators" in step.action && step.action.locators) {
          expect(step.action.locators.length).toBeGreaterThanOrEqual(2);
        }
      }
    });
  }

  it("rip-broken differs from rip only by the chaos flag", async () => {
    const rip = JSON.parse(await readFile(path.join(flowsDir, "rip.flow.json"), "utf8"));
    const broken = JSON.parse(await readFile(path.join(flowsDir, "rip-broken.flow.json"), "utf8"));
    const pathOf = (s: { steps: Array<{ id: string; action: { path?: string } }> }) =>
      s.steps.find((st) => st.id === "s5")!.action.path;
    expect(pathOf(rip)).toBe("/open");
    expect(pathOf(broken)).toBe("/open?break=rip");
    expect(broken.steps.length).toBe(rip.steps.length);
  });
});
