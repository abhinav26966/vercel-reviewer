/**
 * Service worker (doc 03 A2): owns the recording session. chrome.debugger (CDP)
 * provides screenshots + network windows + navigation events; when attach fails
 * (e.g. another debugger present), recording DEGRADES gracefully — those trace
 * fields are nullable by schema. On Stop: assemble RecordingTrace, zip with the
 * screenshot/DOM bundle, upload to POST /api/recordings.
 */
import { zipSync, strToU8 } from "fflate";

interface TraceEvent {
  id: string;
  ts: number;
  type: string;
  url: string;
  target: unknown | null;
  value: string | null;
  screenshotBefore: string | null;
  screenshotAfter: string | null;
  domSnapshotAfter: string | null;
  network: Array<{ method: string; url: string; status: number; ttfbMs: number; totalMs: number; resourceType: string }>;
}

interface NetLogEntry {
  requestId: string;
  method: string;
  url: string;
  resourceType: string;
  startTs: number;
  status: number;
  ttfbMs: number;
  totalMs: number;
  finished: boolean;
}

interface RecordingState {
  tabId: number;
  apiUrl: string;
  token: string;
  projectId: string;
  flowName: string;
  origin: string;
  startedAt: number;
  startedAtIso: string;
  viewport: { width: number; height: number; dpr: number };
  userAgent: string;
  events: TraceEvent[];
  assertionMarkers: number[];
  files: Map<string, Uint8Array>;
  netLog: Map<string, NetLogEntry>;
  debuggerAttached: boolean;
  lastShotAt: number;
  lastShotKey: string | null;
  seq: number;
}

let rec: RecordingState | null = null;

const SHOT_THROTTLE_MS = 600;

async function captureShot(label: string): Promise<string | null> {
  if (!rec?.debuggerAttached) return null;
  if (Date.now() - rec.lastShotAt < SHOT_THROTTLE_MS) return rec.lastShotKey;
  try {
    const result = (await chrome.debugger.sendCommand({ tabId: rec.tabId }, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 55,
    })) as { data: string };
    const key = `shots/${label}.jpg`;
    rec.files.set(key, Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0)));
    rec.lastShotAt = Date.now();
    rec.lastShotKey = key;
    return key;
  } catch {
    return null;
  }
}

function onDebuggerEvent(source: chrome.debugger.Debuggee, method: string, params?: object): void {
  if (!rec || source.tabId !== rec.tabId) return;
  const p = (params ?? {}) as Record<string, unknown>;
  if (method === "Network.requestWillBeSent") {
    const req = p["request"] as unknown as { method: string; url: string };
    rec.netLog.set(p["requestId"] as unknown as string, {
      requestId: p["requestId"] as unknown as string,
      method: req.method,
      url: req.url,
      resourceType: ((p["type"] as unknown as string) ?? "other").toLowerCase(),
      startTs: Date.now(),
      status: 0,
      ttfbMs: 0,
      totalMs: 0,
      finished: false,
    });
  } else if (method === "Network.responseReceived") {
    const entry = rec.netLog.get(p["requestId"] as unknown as string);
    if (entry) {
      entry.status = (p["response"] as unknown as { status: number }).status;
      entry.ttfbMs = Date.now() - entry.startTs;
    }
  } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
    const entry = rec.netLog.get(p["requestId"] as unknown as string);
    if (entry) {
      entry.totalMs = Date.now() - entry.startTs;
      entry.finished = true;
    }
  } else if (method === "Page.navigatedWithinDocument") {
    // SPA route changes (Next.js Link / history.pushState) — no frame navigation fires
    const url = p["url"] as unknown as string;
    if (url && !url.startsWith("chrome")) {
      rec.events.push({
        id: `evt_${String(++rec.seq).padStart(4, "0")}`,
        ts: Date.now() - rec.startedAt,
        type: "navigation",
        url,
        target: null,
        value: null,
        screenshotBefore: rec.lastShotKey,
        screenshotAfter: null,
        domSnapshotAfter: null,
        network: [],
      });
    }
  } else if (method === "Page.frameNavigated") {
    const frame = p["frame"] as unknown as { parentId?: string; url: string };
    if (!frame.parentId && !frame.url.startsWith("chrome")) {
      rec.events.push({
        id: `evt_${String(++rec.seq).padStart(4, "0")}`,
        ts: Date.now() - rec.startedAt,
        type: "navigation",
        url: frame.url,
        target: null,
        value: null,
        screenshotBefore: rec.lastShotKey,
        screenshotAfter: null,
        domSnapshotAfter: null,
        network: [],
      });
    }
  }
}

chrome.debugger.onEvent.addListener(onDebuggerEvent);

async function startRecording(opts: {
  tabId: number;
  apiUrl: string;
  token: string;
  projectId: string;
  flowName: string;
}): Promise<{ ok: boolean; degraded: boolean; error?: string }> {
  const tab = await chrome.tabs.get(opts.tabId);
  let attached = false;
  try {
    await chrome.debugger.attach({ tabId: opts.tabId }, "1.3");
    await chrome.debugger.sendCommand({ tabId: opts.tabId }, "Network.enable");
    await chrome.debugger.sendCommand({ tabId: opts.tabId }, "Page.enable");
    attached = true;
  } catch (err) {
    // another debugger (DevTools, automation) already attached → degrade
    console.warn("flowguard: debugger attach failed — recording without CDP", err);
  }

  const injection = await chrome.scripting.executeScript({
    target: { tabId: opts.tabId },
    func: () => ({
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
      ua: navigator.userAgent,
      origin: location.origin,
    }),
  });
  const env = injection[0]?.result;
  if (!env) return { ok: false, degraded: true, error: "could not inspect the tab" };

  rec = {
    tabId: opts.tabId,
    apiUrl: opts.apiUrl.replace(/\/$/, ""),
    token: opts.token,
    projectId: opts.projectId,
    flowName: opts.flowName,
    origin: env.origin ?? new URL(tab.url ?? "https://unknown").origin,
    startedAt: Date.now(),
    startedAtIso: new Date().toISOString(),
    viewport: { width: env.width, height: env.height, dpr: env.dpr },
    userAgent: env.ua,
    events: [],
    assertionMarkers: [],
    files: new Map(),
    netLog: new Map(),
    debuggerAttached: attached,
    lastShotAt: 0,
    lastShotKey: null,
    seq: 0,
  };
  await chrome.tabs.sendMessage(opts.tabId, { kind: "flowguard:set-recording", recording: true });
  await captureShot("start");
  return { ok: true, degraded: !attached };
}

async function handleCapturedEvent(event: {
  type: string;
  ts: number;
  url: string;
  target: unknown;
  value: string | null;
}): Promise<void> {
  if (!rec) return;
  const id = `evt_${String(++rec.seq).padStart(4, "0")}`;
  const before = rec.lastShotKey;
  const traceEvent: TraceEvent = {
    id,
    ts: event.ts - rec.startedAt,
    type: event.type,
    url: event.url,
    target: event.target,
    value: event.value,
    screenshotBefore: before,
    screenshotAfter: null,
    domSnapshotAfter: null,
    network: [],
  };
  rec.events.push(traceEvent);

  // "after" artifacts: give the page a beat to react, then capture (throttled)
  setTimeout(() => {
    void (async () => {
      if (!rec) return;
      traceEvent.screenshotAfter = await captureShot(`${id}_after`);
      try {
        const snap = (await chrome.tabs.sendMessage(rec.tabId, { kind: "flowguard:dom-snapshot" })) as {
          outline: unknown;
        };
        const key = `dom/${id}.json`;
        rec.files.set(key, strToU8(JSON.stringify(snap.outline)));
        traceEvent.domSnapshotAfter = key;
      } catch {
        /* page may have navigated */
      }
    })();
  }, 450);
}

function assignNetworkWindows(): void {
  if (!rec) return;
  const events = rec.events;
  const entries = [...rec.netLog.values()].filter((e) => e.finished && !e.url.startsWith("data:"));
  for (const entry of entries) {
    // attach to the last event that started before the request
    let owner: TraceEvent | null = null;
    for (const ev of events) {
      if (rec.startedAt + ev.ts <= entry.startTs) owner = ev;
      else break;
    }
    owner?.network.push({
      method: entry.method,
      url: entry.url,
      status: entry.status,
      ttfbMs: Math.round(entry.ttfbMs),
      totalMs: Math.round(entry.totalMs),
      resourceType: entry.resourceType,
    });
  }
}

async function stopRecording(): Promise<{ ok: boolean; recordingId?: string; error?: string; events?: number }> {
  if (!rec) return { ok: false, error: "not recording" };
  const state = rec;
  try {
    await chrome.tabs.sendMessage(state.tabId, { kind: "flowguard:set-recording", recording: false });
  } catch {
    /* tab may be gone */
  }
  const finalShot = await captureShot("final");
  if (state.debuggerAttached) {
    await chrome.debugger.detach({ tabId: state.tabId }).catch(() => {});
  }
  assignNetworkWindows();

  const trace = {
    traceVersion: 1,
    recordedAt: state.startedAtIso,
    origin: state.origin,
    viewport: state.viewport,
    userAgent: state.userAgent,
    events: state.events,
    finalScreenshot: finalShot,
    consoleErrors: [],
    assertionMarkers: state.assertionMarkers,
  };

  const zipInput: Record<string, Uint8Array> = { "trace.json": strToU8(JSON.stringify(trace, null, 2)) };
  for (const [key, data] of state.files) zipInput[key] = data;
  const zipped = zipSync(zipInput, { level: 6 });

  const form = new FormData();
  form.append("projectId", state.projectId);
  form.append("flowName", state.flowName);
  form.append("bundle", new Blob([zipped as unknown as BlobPart], { type: "application/zip" }), "recording.zip");

  try {
    const res = await fetch(`${state.apiUrl}/api/recordings`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}` },
      body: form,
    });
    const body = (await res.json()) as { recordingId?: string; error?: string };
    rec = null;
    if (!res.ok) return { ok: false, error: body.error ?? `upload failed (${res.status})` };
    return { ok: true, recordingId: body.recordingId, events: trace.events.length };
  } catch (err) {
    rec = null;
    return { ok: false, error: String(err) };
  }
}

chrome.runtime.onMessage.addListener((msg: Record<string, unknown>, sender, sendResponse) => {
  void (async () => {
    switch (msg["kind"]) {
      case "flowguard:event":
        if (sender.tab?.id === rec?.tabId) await handleCapturedEvent(msg["event"] as Parameters<typeof handleCapturedEvent>[0]);
        sendResponse({ ok: true });
        break;
      case "flowguard:start":
        sendResponse(await startRecording(msg as unknown as Parameters<typeof startRecording>[0]));
        break;
      case "flowguard:stop":
        sendResponse(await stopRecording());
        break;
      case "flowguard:mark-assertion":
        if (rec) rec.assertionMarkers.push(Date.now() - rec.startedAt);
        sendResponse({ ok: Boolean(rec) });
        break;
      case "flowguard:query-recording":
        sendResponse({ recording: Boolean(rec && sender.tab?.id === rec.tabId) });
        break;
      case "flowguard:status":
        sendResponse({ recording: Boolean(rec), events: rec?.events.length ?? 0, degraded: rec ? !rec.debuggerAttached : false });
        break;
    }
  })();
  return true; // async sendResponse
});
