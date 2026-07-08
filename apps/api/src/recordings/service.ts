import { unzipSync, strFromU8 } from "fflate";
import { RecordingTraceSchema } from "@flowguard/schemas";
import { ValidationError } from "@flowguard/shared";
import type { Store } from "../store.js";
import { importDevToolsRecording, type DevToolsRecording } from "./devtools-import.js";

export interface RecordingDeps {
  store: Store;
  /** Persist the raw bundle; returns nothing — key is provided by caller. */
  putObject: (key: string, data: Buffer, contentType: string) => Promise<void>;
}

/**
 * POST /api/recordings handler core (doc 03 A2 upload): unzip → Zod-validate
 * trace.json → store bundle in S3 → recordings row (status 'uploaded'; the
 * compile job of Phase 6 picks it up from there).
 */
export async function handleRecordingUpload(
  deps: RecordingDeps,
  input: { projectId: string; flowName: string | null; bundle: Buffer },
): Promise<{ recordingId: string; events: number }> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(input.bundle);
  } catch {
    throw new ValidationError("bundle is not a valid zip");
  }
  const traceRaw = files["trace.json"];
  if (!traceRaw) throw new ValidationError("bundle is missing trace.json");

  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(traceRaw));
  } catch {
    throw new ValidationError("trace.json is not valid JSON");
  }
  const trace = RecordingTraceSchema.safeParse(parsed);
  if (!trace.success) {
    throw new ValidationError("trace failed schema validation", {
      issues: trace.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }

  // referenced artifacts must exist in the bundle
  for (const ev of trace.data.events) {
    for (const key of [ev.screenshotBefore, ev.screenshotAfter, ev.domSnapshotAfter]) {
      if (key && !files[key]) {
        throw new ValidationError(`trace references missing bundle file: ${key}`);
      }
    }
  }

  const recordingId = await deps.store.createRecording({
    projectId: input.projectId,
    flowName: input.flowName,
    traceKey: "", // set below once we know the id-based key
    origin: trace.data.origin,
    status: "uploaded",
  });
  const traceKey = `recordings/${recordingId}/bundle.zip`;
  await deps.putObject(traceKey, input.bundle, "application/zip");
  await deps.store.setRecordingTraceKey(recordingId, traceKey);
  return { recordingId, events: trace.data.events.length };
}

/** POST /api/recordings/import-devtools core (doc 03 A3 degraded-mode import). */
export async function handleDevToolsImport(
  deps: RecordingDeps,
  input: { projectId: string; flowName: string | null; recording: DevToolsRecording },
): Promise<{ recordingId: string; events: number }> {
  if (!Array.isArray(input.recording?.steps)) {
    throw new ValidationError("not a DevTools Recorder export (missing steps)");
  }
  const trace = importDevToolsRecording(input.recording); // throws ZodError if unmappable
  const recordingId = await deps.store.createRecording({
    projectId: input.projectId,
    flowName: input.flowName,
    traceKey: "",
    origin: trace.origin,
    status: "uploaded",
  });
  const traceKey = `recordings/${recordingId}/trace.json`;
  await deps.putObject(traceKey, Buffer.from(JSON.stringify(trace, null, 2)), "application/json");
  await deps.store.setRecordingTraceKey(recordingId, traceKey);
  return { recordingId, events: trace.events.length };
}
