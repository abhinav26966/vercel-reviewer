import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { handleDevToolsImport, handleRecordingUpload } from "../src/recordings/service.js";
import { importDevToolsRecording, mapSelector } from "../src/recordings/devtools-import.js";
import { FakeStore } from "./fakes.js";

function minimalTrace(overrides: Record<string, unknown> = {}) {
  return {
    traceVersion: 1,
    recordedAt: "2026-07-08T12:00:00Z",
    origin: "https://demo.vercel.app",
    viewport: { width: 1280, height: 720, dpr: 1 },
    userAgent: "test",
    events: [
      {
        id: "evt_0001",
        ts: 100,
        type: "click",
        url: "https://demo.vercel.app/shop",
        target: {
          tag: "button",
          locators: [
            { kind: "testid", value: "buy-pack-btn" },
            { kind: "css", value: "button" },
          ],
          a11y: null,
          boundingBox: null,
          isCanvas: false,
          canvasRelative: null,
        },
        value: null,
        screenshotBefore: "shots/evt_0001_before.jpg",
        screenshotAfter: null,
        domSnapshotAfter: null,
        network: [],
      },
    ],
    finalScreenshot: null,
    consoleErrors: [],
    assertionMarkers: [1500],
    ...overrides,
  };
}

function deps() {
  const store = new FakeStore();
  const objects = new Map<string, Buffer>();
  return {
    store,
    objects,
    recordingDeps: {
      store,
      putObject: async (key: string, data: Buffer) => void objects.set(key, data),
    },
  };
}

describe("handleRecordingUpload", () => {
  it("accepts a valid bundle: validates trace, stores zip, creates row", async () => {
    const d = deps();
    const zip = zipSync({
      "trace.json": strToU8(JSON.stringify(minimalTrace())),
      "shots/evt_0001_before.jpg": new Uint8Array([1, 2, 3]),
    });
    const res = await handleRecordingUpload(d.recordingDeps, {
      projectId: "prj_1",
      flowName: "Buy & Rip",
      bundle: Buffer.from(zip),
    });
    expect(res.events).toBe(1);
    expect(d.store.recordings[0]).toMatchObject({ status: "uploaded", flowName: "Buy & Rip" });
    expect(d.store.recordings[0]!.traceKey).toBe(`recordings/${res.recordingId}/bundle.zip`);
    expect(d.objects.has(`recordings/${res.recordingId}/bundle.zip`)).toBe(true);
  });

  it("rejects non-zip, missing trace.json, invalid trace, and dangling artifact refs", async () => {
    const d = deps();
    await expect(
      handleRecordingUpload(d.recordingDeps, { projectId: "p", flowName: null, bundle: Buffer.from("junk") }),
    ).rejects.toThrow("not a valid zip");

    await expect(
      handleRecordingUpload(d.recordingDeps, {
        projectId: "p",
        flowName: null,
        bundle: Buffer.from(zipSync({ "other.json": strToU8("{}") })),
      }),
    ).rejects.toThrow("missing trace.json");

    await expect(
      handleRecordingUpload(d.recordingDeps, {
        projectId: "p",
        flowName: null,
        bundle: Buffer.from(zipSync({ "trace.json": strToU8(JSON.stringify({ traceVersion: 2 })) })),
      }),
    ).rejects.toThrow("schema validation");

    // trace references a screenshot that isn't in the bundle
    await expect(
      handleRecordingUpload(d.recordingDeps, {
        projectId: "p",
        flowName: null,
        bundle: Buffer.from(zipSync({ "trace.json": strToU8(JSON.stringify(minimalTrace())) })),
      }),
    ).rejects.toThrow("missing bundle file");
  });
});

describe("DevTools Recorder import (doc 03 A3)", () => {
  const devtoolsExport = {
    title: "buy and rip",
    steps: [
      { type: "setViewport", width: 1280, height: 720, deviceScaleFactor: 1 },
      { type: "navigate", url: "https://demo.vercel.app/login" },
      {
        type: "change",
        selectors: [["aria/Email"], ["#em"], ["xpath//input[1]"]],
        value: "default@demo.dev",
      },
      {
        type: "change",
        selectors: [["aria/Password"], ["input[type='password']"]],
        value: "demo1234",
      },
      {
        type: "click",
        selectors: [["aria/Log in[role=\"button\"]"], ["[data-testid='login-submit']"], ["xpath//button"]],
      },
      { type: "keyDown", key: "Enter" },
      { type: "navigate", url: "https://demo.vercel.app/shop" },
      { type: "click", selectors: [["aria/Buy Pack[role=\"button\"]"], ["#shop-grid button"]] },
    ],
  };

  it("maps selectors: aria→role/text, css, testid; xpath dropped", () => {
    expect(mapSelector('aria/Log in[role="button"]')).toEqual({
      kind: "role",
      value: { role: "button", name: "Log in" },
    });
    expect(mapSelector("aria/Email")).toEqual({ kind: "text", value: "Email" });
    expect(mapSelector("[data-testid='login-submit']")).toEqual({ kind: "testid", value: "login-submit" });
    expect(mapSelector("xpath//button")).toBeNull();
    expect(mapSelector("#shop button")).toEqual({ kind: "css", value: "#shop button" });
  });

  it("produces a schema-valid trace with redacted password fields", () => {
    const trace = importDevToolsRecording(devtoolsExport);
    expect(trace.origin).toBe("https://demo.vercel.app");
    expect(trace.viewport).toEqual({ width: 1280, height: 720, dpr: 1 });
    const types = trace.events.map((e) => e.type);
    expect(types).toEqual(["navigation", "input", "input", "click", "keypress", "navigation", "click"]);
    const pw = trace.events[2]!;
    expect(pw.value).toBe("«redacted:password»");
    const login = trace.events[3]!;
    expect(login.target!.locators).toContainEqual({ kind: "role", value: { role: "button", name: "Log in" } });
    expect(login.target!.locators).toContainEqual({ kind: "testid", value: "login-submit" });
    expect(JSON.stringify(trace)).not.toContain("xpath");
  });

  it("import endpoint core stores the mapped trace", async () => {
    const d = deps();
    const res = await handleDevToolsImport(d.recordingDeps, {
      projectId: "prj_1",
      flowName: "Buy & Rip (devtools)",
      recording: devtoolsExport,
    });
    expect(res.events).toBe(7);
    expect(d.objects.has(`recordings/${res.recordingId}/trace.json`)).toBe(true);
  });

  it("rejects non-recorder JSON", async () => {
    const d = deps();
    await expect(
      handleDevToolsImport(d.recordingDeps, {
        projectId: "p",
        flowName: null,
        recording: { nope: true } as never,
      }),
    ).rejects.toThrow("missing steps");
  });
});
