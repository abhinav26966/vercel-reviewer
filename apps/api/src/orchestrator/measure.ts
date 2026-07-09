import type { RunFlowResult } from "@flowguard/schemas";

/**
 * Timing trust protocol (doc 04 §4): warm-up first (discarded), then median of
 * N=2 measured runs. The FIRST run is authoritative for pass/fail — the second
 * exists for timing only, so measurement never doubles the false-positive
 * surface (a second-run functional flake is recorded, not reported).
 */
export const MEASURE_SAMPLES = 2;

export function mergeMeasuredResults(m1: RunFlowResult, m2: RunFlowResult | null): RunFlowResult {
  if (!m2) return m1;
  if (m1.status !== "passed" || m2.status !== "passed") {
    if (m1.status === "passed" && m2.status !== "passed") {
      // functional flake on the timing sample — surface as a diagnostic only
      return {
        ...m1,
        diagnostics: {
          ...m1.diagnostics,
          consoleErrors: [
            ...m1.diagnostics.consoleErrors,
            { text: `measurement sample disagreed: second run ${m2.status} (${m2.failureClass ?? "?"}) — timings from run 1 only` },
          ],
        },
      };
    }
    return m1;
  }
  const steps = m1.steps.map((s1) => {
    const s2 = m2.steps.find((s) => s.id === s1.id);
    if (!s2) return s1;
    return {
      ...s1,
      durationMs: median2(s1.durationMs, s2.durationMs),
      settleMs: median2(s1.settleMs, s2.settleMs),
    };
  });
  return {
    ...m1,
    steps,
    perf: { ...m1.perf, flowTotalMs: median2(m1.perf.flowTotalMs, m2.perf.flowTotalMs) },
  };
}

/** median of two samples = their midpoint. */
function median2(a: number, b: number): number {
  return Math.round((a + b) / 2);
}
