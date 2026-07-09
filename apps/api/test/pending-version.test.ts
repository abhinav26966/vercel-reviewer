import { describe, expect, it } from "vitest";
import { FlowSpecSchema, RunFlowResultSchema, type FlowSpec } from "@flowguard/schemas";
import { applyHealPatch, createPendingVersion } from "../src/orchestrator/pending-version.js";
import { FakeStore } from "./fakes.js";
import type { Store } from "../src/store.js";

const spec: FlowSpec = FlowSpecSchema.parse({
  specVersion: 3,
  flowId: "flw_rip",
  projectId: "prj_1",
  name: "Buy & Rip",
  startPath: "/shop",
  steps: [
    {
      id: "s1",
      title: "Click Buy Pack",
      action: { type: "click", locators: [{ kind: "testid", value: "buy-pack-btn" }, { kind: "text", value: "Buy Pack" }] },
      settle: { strategy: "navigation", timeoutMs: 15000 },
      postConditions: [],
    },
  ],
});

describe("applyHealPatch", () => {
  it("prepends the healed locator onto the step's stack", () => {
    const patched = applyHealPatch(spec, {
      stepId: "s1",
      locators: [{ kind: "testid", value: "get-pack-btn" }, { kind: "testid", value: "buy-pack-btn" }],
    });
    const action = patched.steps[0]!.action as { locators: Array<{ value: unknown }> };
    expect(action.locators[0]!.value).toBe("get-pack-btn");
    expect(action.locators).toHaveLength(2);
  });

  it("ignores malformed patches (spec unchanged)", () => {
    expect(applyHealPatch(spec, { nonsense: true })).toEqual(spec);
    expect(applyHealPatch(spec, null)).toEqual(spec);
  });
});

describe("createPendingVersion (the approved-🔵 path, doc 05 §3.6)", () => {
  function makeStore() {
    const store = new FakeStore();
    store.officialFlows.push({
      flowId: "flw_rip",
      flowName: "Buy & Rip",
      tier: "standard",
      specVersionId: "fsv_official",
      spec,
      branch: "main",
      projectId: "prj_1",
    });
    return store;
  }

  it("mints a pending version superseding the official", async () => {
    const store = makeStore();
    const id = await createPendingVersion({
      store: store as unknown as Store,
      flowId: "flw_rip",
      runId: "run_1",
      branch: "main",
      note: "approved 🔵",
    });
    expect(id).toBeTruthy();
    const row = store.versionRows.find((v) => v.id === id)!;
    expect(row.status).toBe("pending");
    expect(row.compilationReport).toMatchObject({
      approvedFromRunId: "run_1",
      supersedesVersionId: "fsv_official",
      healPatchApplied: false,
    });
  });

  it("applies the head run's heal patch when one exists", async () => {
    const store = makeStore();
    store.runFlowResults.push({
      id: "rfr_1",
      runId: "run_1",
      flowId: "flw_rip",
      specVersionId: "fsv_official",
      target: "head",
      fromCache: false,
      result: RunFlowResultSchema.parse({
        runId: "run_1",
        flowId: "flw_rip",
        specVersionId: "fsv_official",
        target: "head",
        status: "passed",
        healAttempt: {
          attempted: true,
          succeeded: true,
          proposedPatch: {
            stepId: "s1",
            locators: [
              { kind: "testid", value: "get-pack-btn" },
              { kind: "testid", value: "buy-pack-btn" },
            ],
          },
        },
      }),
    });
    const id = await createPendingVersion({
      store: store as unknown as Store,
      flowId: "flw_rip",
      runId: "run_1",
      branch: "main",
      note: "approved 🔵",
    });
    const row = store.versionRows.find((v) => v.id === id)!;
    const action = row.spec.steps[0]!.action as { locators: Array<{ value: unknown }> };
    expect(action.locators[0]!.value).toBe("get-pack-btn");
    expect(row.compilationReport).toMatchObject({ healPatchApplied: true });
  });

  it("returns null when there is no official version to supersede", async () => {
    const store = new FakeStore();
    const id = await createPendingVersion({
      store: store as unknown as Store,
      flowId: "flw_missing",
      runId: "run_1",
      branch: "main",
      note: "x",
    });
    expect(id).toBeNull();
  });
});
