import { describe, expect, it } from "vitest";
import { FlowSpecSchema, RunFlowResultSchema, type FlowSpec, type RunFlowResult } from "@flowguard/schemas";
import { compareFlow, computePerfRegressions } from "../src/orchestrator/comparator.js";
import { mergeMeasuredResults } from "../src/orchestrator/measure.js";

const spec: FlowSpec = FlowSpecSchema.parse({
  specVersion: 3,
  flowId: "flw_1",
  projectId: "prj_1",
  name: "Buy",
  startPath: "/shop",
  steps: [
    {
      id: "s1",
      title: "Buy a pack",
      action: {
        type: "click",
        locators: [
          { kind: "testid", value: "buy-pack-btn" },
          { kind: "css", value: "button" },
        ],
      },
      settle: { strategy: "navigation", timeoutMs: 15000 },
      timingBaselineKey: "s1",
    },
  ],
});

function result(opts: {
  durationMs: number;
  settleMs?: number;
  ttfb?: number;
  target?: "head" | "base";
}): RunFlowResult {
  return RunFlowResultSchema.parse({
    runId: "r",
    flowId: "flw_1",
    specVersionId: "v",
    target: opts.target ?? "head",
    status: "passed",
    steps: [
      {
        id: "s1",
        durationMs: opts.durationMs,
        settleMs: opts.settleMs ?? 50,
        network:
          opts.ttfb !== undefined
            ? [
                {
                  method: "POST",
                  url: "https://x/api/packs/buy",
                  status: 303,
                  ttfbMs: opts.ttfb,
                  totalMs: opts.ttfb + 30,
                  resourceType: "fetch",
                },
              ]
            : [],
        screenshot: null,
        assertions: [],
      },
    ],
    perf: { flowTotalMs: opts.durationMs, regressions: [] },
  });
}

const link = (k: string, l: string) => `[${l}](${k})`;

describe("computePerfRegressions (dual threshold + attribution, doc 04 §4)", () => {
  it("flags a network-attributed regression past both thresholds", () => {
    const head = result({ durationMs: 1900, ttfb: 1720 });
    const base = result({ durationMs: 210, ttfb: 84, target: "base" });
    const findings = computePerfRegressions(spec, head, base);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.attribution).toEqual({
      kind: "network",
      request: "POST /api/packs/buy",
      baseTtfb: 84,
      headTtfb: 1720,
    });
  });

  it("passes only ONE threshold → no flag (dual-threshold protection)", () => {
    // 4× relative but only +300ms absolute (floor is 500)
    expect(computePerfRegressions(spec, result({ durationMs: 400 }), result({ durationMs: 100, target: "base" }))).toHaveLength(0);
    // +900ms absolute but only 1.5× relative (factor is 3)
    expect(computePerfRegressions(spec, result({ durationMs: 2700 }), result({ durationMs: 1800, target: "base" }))).toHaveLength(0);
  });

  it("client attribution when settle grew instead of network", () => {
    const head = result({ durationMs: 2000, settleMs: 1800 });
    const base = result({ durationMs: 300, settleMs: 100, target: "base" });
    const findings = computePerfRegressions(spec, head, base);
    expect(findings[0]!.attribution).toEqual({ kind: "client", settleDelta: 1700 });
  });

  it("suppresses UNATTRIBUTED regressions (false positives are death)", () => {
    // duration exploded but neither network nor settle explains it
    const head = result({ durationMs: 2000, settleMs: 60, ttfb: 90 });
    const base = result({ durationMs: 300, settleMs: 50, ttfb: 84, target: "base" });
    expect(computePerfRegressions(spec, head, base)).toHaveLength(0);
  });
});

describe("compareFlow perf verdicts", () => {
  it("passing + attributed regression → 🟡 slower with the waterfall detail", () => {
    const c = compareFlow({
      spec,
      head: result({ durationMs: 1900, ttfb: 1720 }),
      base: result({ durationMs: 210, ttfb: 84, target: "base" }),
      baseAvailable: true,
      link,
    });
    expect(c.verdict).toBe("slower");
    expect(c.detail).toContain('step s1 "Buy a pack": 210ms → 1.9s');
    expect(c.detail).toContain("POST /api/packs/buy` TTFB 84ms→1.7s");
  });

  it("hung/dead heads map to 🟠 verdicts when base is green", () => {
    const hung = RunFlowResultSchema.parse({
      ...result({ durationMs: 500 }),
      status: "hung",
      failedStepId: "s1",
      failureClass: "hung_postcondition",
    });
    expect(
      compareFlow({ spec, head: hung, base: result({ durationMs: 200, target: "base" }), baseAvailable: true, link })
        .verdict,
    ).toBe("hung");
    const dead = RunFlowResultSchema.parse({
      ...result({ durationMs: 500 }),
      status: "dead",
      failedStepId: "s1",
      failureClass: "blank_screen",
    });
    expect(
      compareFlow({ spec, head: dead, base: result({ durationMs: 200, target: "base" }), baseAvailable: true, link })
        .verdict,
    ).toBe("dead");
  });

  it("hung on head + hung on base → ⬜ (the honesty rule)", () => {
    const hung = RunFlowResultSchema.parse({
      ...result({ durationMs: 500 }),
      status: "hung",
      failedStepId: "s1",
      failureClass: "hung_postcondition",
    });
    const baseHung = RunFlowResultSchema.parse({ ...hung, target: "base" });
    expect(compareFlow({ spec, head: hung, base: baseHung, baseAvailable: true, link }).verdict).toBe(
      "already_broken_on_base",
    );
  });
});

describe("mergeMeasuredResults", () => {
  it("medians timings across two passing samples", () => {
    const merged = mergeMeasuredResults(result({ durationMs: 1000, settleMs: 100 }), result({ durationMs: 2000, settleMs: 300 }));
    expect(merged.steps[0]!.durationMs).toBe(1500);
    expect(merged.steps[0]!.settleMs).toBe(200);
  });

  it("sample-2 functional flake never flips the verdict (run 1 authoritative)", () => {
    const failed2 = RunFlowResultSchema.parse({
      ...result({ durationMs: 900 }),
      status: "failed",
      failedStepId: "s1",
      failureClass: "assertion",
    });
    const merged = mergeMeasuredResults(result({ durationMs: 1000 }), failed2);
    expect(merged.status).toBe("passed");
    expect(JSON.stringify(merged.diagnostics.consoleErrors)).toContain("measurement sample disagreed");
  });
});
