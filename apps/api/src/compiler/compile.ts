import { strFromU8, unzipSync } from "fflate";
import type { Logger } from "pino";
import { RecordingTraceSchema } from "@flowguard/schemas";
import type { InferenceProvider } from "@flowguard/inference";
import { newId } from "@flowguard/shared";
import type { Store } from "../store.js";
import { assembleSpec, collectKnownTestIds } from "./assemble.js";
import { detectLogin, detectPaymentContext } from "./detect.js";
import { normalizeTrace } from "./normalize.js";
import { runVisionPass } from "./vision-pass.js";

export interface CompileDeps {
  store: Store;
  inference: InferenceProvider;
  getObject: (key: string) => Promise<Buffer>;
  logger: Logger;
}

/**
 * The compile job (doc 03 Part B): recording bundle → draft Flow Spec +
 * compilationReport. Deterministic stages are code; the model supplies the
 * semantic layer only.
 */
export async function compileRecording(
  deps: CompileDeps,
  recordingId: string,
): Promise<{ flowId: string; versionId: string }> {
  const { store, logger } = deps;
  const recording = await store.getRecording(recordingId);
  if (!recording) throw new Error(`recording not found: ${recordingId}`);
  await store.updateRecording(recordingId, { status: "compiling" });

  try {
    const bundle = await deps.getObject(recording.traceKey);
    const files = recording.traceKey.endsWith(".zip")
      ? unzipSync(bundle)
      : { "trace.json": new Uint8Array(bundle) };
    const trace = RecordingTraceSchema.parse(JSON.parse(strFromU8(files["trace.json"]!)));

    // stage 1: normalize & segment
    const normalized = normalizeTrace(trace);
    // stage 5 (code-side detection first — login events never reach the model)
    const login = detectLogin(normalized.events);
    const paymentEventIds = new Set(detectPaymentContext(normalized.events));
    const hasPaymentConfig = Boolean(await store.resolvePaymentConfig(recording.projectId, null));
    const flowEvents = login ? normalized.events.slice(login.resumeIndex) : normalized.events;
    const interactionEvents = flowEvents.filter((e) => e.event.type !== "navigation");

    // hallucination guard inputs: every testid the pages actually contained
    const outlines = Object.entries(files)
      .filter(([k]) => k.startsWith("dom/"))
      .map(([, data]) => JSON.parse(strFromU8(data)) as unknown);
    const knownTestIds = collectKnownTestIds(outlines);

    // stages 3–4: vision passes (batched)
    const vision = await runVisionPass(deps.inference, interactionEvents, (key) => {
      const f = files[key];
      return f ? Buffer.from(f) : null;
    });
    logger.info(
      { recordingId, suggestions: vision.suggestions.size, failures: vision.failures.length },
      "vision pass complete",
    );

    // stages 2, 6, 7: hardening, delta rewriting, assembly
    const flowId = newId("flow");
    const { spec, report } = assembleSpec({
      trace,
      events: normalized.events,
      login,
      suggestions: vision.suggestions,
      flowMeta: vision.flow,
      recordedFlowName: recording.flowName,
      projectId: recording.projectId,
      flowId,
      knownTestIds,
      dropped: normalized.dropped,
      paymentEventIds,
      hasPaymentConfig,
    });
    report.visionFailures = vision.failures;

    await store.createFlow({
      id: flowId,
      projectId: recording.projectId,
      name: spec.name,
      tier: spec.tier,
      persona: spec.persona,
    });
    const versionId = await store.insertFlowVersion({
      flowId,
      spec,
      status: "draft",
      branch: "main",
      source: "recording",
      sourceRecordingId: recordingId,
      compilationReport: report as unknown as Record<string, unknown>,
    });
    await store.updateRecording(recordingId, { status: "compiled", flowId });
    logger.info({ recordingId, flowId, versionId, steps: spec.steps.length }, "recording compiled to draft spec");
    return { flowId, versionId };
  } catch (err) {
    await store.updateRecording(recordingId, { status: "failed" });
    throw err;
  }
}
