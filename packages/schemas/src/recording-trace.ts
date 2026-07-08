import { z } from "zod";
import { LocatorSchema, ViewportSchema } from "./locators.js";

/**
 * Recording Trace — the raw, verbose, lossless format the Chrome extension emits
 * (doc 02 §1). Source of truth: docs/02-flow-spec-schema.md.
 */

export const TraceNetworkEntrySchema = z.object({
  method: z.string().min(1),
  url: z.string().min(1),
  status: z.number().int(),
  ttfbMs: z.number().nonnegative(),
  totalMs: z.number().nonnegative(),
  resourceType: z.string().min(1),
});

export const TraceEventTypeSchema = z.enum([
  "click",
  "dblclick",
  "input",
  "keypress",
  "scroll",
  "navigation",
  "select",
  "hover",
]);

export const BoundingBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().nonnegative(),
  h: z.number().nonnegative(),
});

export const A11yInfoSchema = z.object({
  role: z.string(),
  name: z.string(),
  path: z.array(z.string()),
});

export const TraceEventTargetSchema = z.object({
  tag: z.string().min(1),
  locators: z.array(LocatorSchema).min(1),
  a11y: A11yInfoSchema.nullable(),
  boundingBox: BoundingBoxSchema.nullable(),
  isCanvas: z.boolean(),
  /** When isCanvas: coordinates normalized to the canvas box. */
  canvasRelative: z.object({ nx: z.number().min(0).max(1), ny: z.number().min(0).max(1) }).nullable(),
});

export const TraceEventSchema = z.object({
  id: z.string().min(1),
  /** ms from recording start */
  ts: z.number().nonnegative(),
  type: TraceEventTypeSchema,
  url: z.string().min(1),
  /** null for pure navigation events (no interacted element). */
  target: TraceEventTargetSchema.nullable(),
  /** For input events: the typed value; REDACTED at source for password/secret fields. */
  value: z.string().nullable(),
  /** Navigation that opened a new tab (doc 03 A3); recorder re-attaches and follows. */
  newTab: z.boolean().optional(),
  /** Artifact-bundle keys; null when the throttled screenshotter skipped this event. */
  screenshotBefore: z.string().nullable(),
  screenshotAfter: z.string().nullable(),
  /** Trimmed a11y-tree snapshot key, not full HTML. */
  domSnapshotAfter: z.string().nullable(),
  /** Requests that started between this event and the next. */
  network: z.array(TraceNetworkEntrySchema).default([]),
});

export const RecordingTraceSchema = z.object({
  traceVersion: z.literal(1),
  recordedAt: z.iso.datetime(),
  origin: z.url(),
  viewport: ViewportSchema,
  userAgent: z.string(),
  events: z.array(TraceEventSchema).min(1),
  finalScreenshot: z.string().nullable(),
  consoleErrors: z
    .array(z.object({ ts: z.number().nonnegative(), text: z.string() }))
    .default([]),
  /**
   * Timestamps (ms from start) where the user pressed "mark assertion here" —
   * a strong hint for the compiler to mint an assertion at that moment (doc 03 A2).
   */
  assertionMarkers: z.array(z.number().nonnegative()).default([]),
});

export type TraceNetworkEntry = z.infer<typeof TraceNetworkEntrySchema>;
export type TraceEvent = z.infer<typeof TraceEventSchema>;
export type RecordingTrace = z.infer<typeof RecordingTraceSchema>;
