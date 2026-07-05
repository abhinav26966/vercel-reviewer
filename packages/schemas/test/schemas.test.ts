import { describe, expect, it } from "vitest";
import {
  ExecuteFlowJobSchema,
  FlowSpecSchema,
  LocatorSchema,
  RecordingTraceSchema,
  RunFlowResultSchema,
  VerdictKindSchema,
  VerdictSchema,
} from "../src/index.js";
import {
  validExecuteFlowJob,
  validFlowSpec,
  validRecordingTrace,
  validRunFlowResult,
  validVerdict,
} from "./fixtures.js";

describe("RecordingTrace", () => {
  it("accepts the doc 02 §1 example", () => {
    const parsed = RecordingTraceSchema.parse(validRecordingTrace);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[0]!.target!.locators[0]).toEqual({ kind: "testid", value: "buy-pack-btn" });
  });

  it("round-trips: parse(JSON.parse(JSON.stringify(parse(x)))) is stable", () => {
    const once = RecordingTraceSchema.parse(validRecordingTrace);
    const twice = RecordingTraceSchema.parse(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });

  it("rejects unknown event types", () => {
    const bad = structuredClone(validRecordingTrace);
    (bad.events[0] as { type: string }).type = "drag";
    expect(RecordingTraceSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a non-1 traceVersion", () => {
    expect(
      RecordingTraceSchema.safeParse({ ...validRecordingTrace, traceVersion: 2 }).success,
    ).toBe(false);
  });
});

describe("Locator", () => {
  it("forbids xpath locators (doc 02 §3)", () => {
    expect(LocatorSchema.safeParse({ kind: "xpath", value: "//button" }).success).toBe(false);
  });

  it("requires role locators to carry role+name objects", () => {
    expect(LocatorSchema.safeParse({ kind: "role", value: "button" }).success).toBe(false);
    expect(
      LocatorSchema.safeParse({ kind: "role", value: { role: "button", name: "Buy Pack" } })
        .success,
    ).toBe(true);
  });
});

describe("FlowSpec", () => {
  it("accepts the doc 02 §2 example", () => {
    const parsed = FlowSpecSchema.parse(validFlowSpec);
    expect(parsed.steps).toHaveLength(4);
    expect(parsed.steps[1]!.action.type).toBe("payment");
    expect(parsed.steps[1]!.caveats).toEqual(["webhook_dependent"]);
    expect(parsed.steps[3]!.settle.quiescence?.stableFrames).toBe(3);
  });

  it("round-trips stably through JSON", () => {
    const once = FlowSpecSchema.parse(validFlowSpec);
    const twice = FlowSpecSchema.parse(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });

  it("applies defaults for lean handwritten specs", () => {
    const parsed = FlowSpecSchema.parse({
      specVersion: 3,
      flowId: "flw_1",
      projectId: "prj_1",
      name: "Login",
      startPath: "/login",
      steps: [
        {
          id: "s1",
          title: "Wait for form",
          action: {
            type: "waitFor",
            locators: [
              { kind: "testid", value: "email-input" },
              { kind: "css", value: "input[type=email]" },
            ],
          },
          settle: { strategy: "networkidle", timeoutMs: 5000 },
        },
      ],
    });
    expect(parsed.viewport).toEqual({ width: 1280, height: 720, dpr: 1 });
    expect(parsed.tier).toBe("standard");
    expect(parsed.persona).toBeNull();
    expect(parsed.budgets.perStepDefaults).toEqual({ relativeFactor: 3.0, absoluteFloorMs: 500 });
  });

  it("rejects DOM actions with fewer than 2 locators (doc 02 §3)", () => {
    const bad = structuredClone(validFlowSpec);
    (bad.steps[0]!.action as { locators: unknown[] }).locators = [
      { kind: "testid", value: "buy-pack-btn" },
    ];
    expect(FlowSpecSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects specVersion !== 3", () => {
    expect(FlowSpecSchema.safeParse({ ...validFlowSpec, specVersion: 2 }).success).toBe(false);
  });

  it("rejects flowEvent settle without an event name", () => {
    const bad = structuredClone(validFlowSpec);
    bad.steps[0]!.settle = { strategy: "flowEvent", timeoutMs: 5000 };
    expect(FlowSpecSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects delta increasedBy without a value", () => {
    const bad = structuredClone(validFlowSpec);
    const delta = bad.steps[2]!.postConditions![0] as { value?: number };
    delete delta.value;
    expect(FlowSpecSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a startPath that is not absolute", () => {
    expect(FlowSpecSchema.safeParse({ ...validFlowSpec, startPath: "shop" }).success).toBe(false);
  });
});

describe("RunFlowResult", () => {
  it("accepts the doc 02 §5 example", () => {
    const parsed = RunFlowResultSchema.parse(validRunFlowResult);
    expect(parsed.status).toBe("failed");
    expect(parsed.failureClass).toBe("assertion");
    expect(parsed.perf.regressions[0]!.attribution.kind).toBe("network");
  });

  it("rejects unknown failure classes", () => {
    expect(
      RunFlowResultSchema.safeParse({ ...validRunFlowResult, failureClass: "gremlins" }).success,
    ).toBe(false);
  });

  it("rejects unknown statuses", () => {
    expect(
      RunFlowResultSchema.safeParse({ ...validRunFlowResult, status: "exploded" }).success,
    ).toBe(false);
  });
});

describe("ExecuteFlowJob", () => {
  it("accepts the doc 04 §1 example with inline spec", () => {
    const parsed = ExecuteFlowJobSchema.parse(validExecuteFlowJob);
    expect(parsed.configBundle.persona?.usernameRef).toBe("sec_1");
    expect(parsed.configBundle.dataBranchDiffers).toBe(true);
    expect(parsed.spec.flowId).toBe("flw_9f2c");
  });

  it("rejects plaintext-looking payment config (missing cvcRef)", () => {
    const bad = structuredClone(validExecuteFlowJob) as Record<string, never> & {
      configBundle: { payment: Record<string, unknown> };
    };
    delete bad.configBundle.payment.cvcRef;
    bad.configBundle.payment.cvc = "123";
    expect(ExecuteFlowJobSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects non-URL deployment targets", () => {
    const bad = structuredClone(validExecuteFlowJob);
    bad.target.deploymentUrl = "not-a-url";
    expect(ExecuteFlowJobSchema.safeParse(bad).success).toBe(false);
  });
});

describe("Verdict", () => {
  it("accepts the full taxonomy of doc 05 §1", () => {
    for (const v of [
      "passing",
      "broken",
      "slower",
      "hung",
      "dead",
      "changed_as_intended",
      "skipped",
      "already_broken_on_base",
      "env_issue",
    ]) {
      expect(VerdictKindSchema.safeParse(v).success).toBe(true);
    }
  });

  it("rejects verdicts outside the taxonomy", () => {
    expect(VerdictKindSchema.safeParse("maybe_fine").success).toBe(false);
  });

  it("accepts a full verdict row", () => {
    expect(VerdictSchema.parse(validVerdict).verdict).toBe("broken");
  });
});
