const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
const statusEl = () => document.getElementById("status")!;

const FIELDS = ["apiUrl", "token", "projectId", "flowName"] as const;

async function restore(): Promise<void> {
  const saved = await chrome.storage.local.get([...FIELDS]);
  for (const f of FIELDS) if (saved[f]) $(f).value = saved[f] as string;
  if (!$("apiUrl").value) $("apiUrl").value = "http://localhost:8787";
  await refreshStatus();
}

async function persist(): Promise<void> {
  const entries = Object.fromEntries(FIELDS.map((f) => [f, $(f).value]));
  await chrome.storage.local.set(entries);
}

async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("no active tab");
  return tab.id;
}

async function refreshStatus(): Promise<void> {
  const s = (await chrome.runtime.sendMessage({ kind: "flowguard:status" })) as {
    recording: boolean;
    events: number;
    degraded: boolean;
  };
  statusEl().innerHTML = s.recording
    ? `<span class="rec">● recording</span> — ${s.events} steps captured${s.degraded ? " (degraded: no CDP)" : ""}`
    : "idle";
}

document.getElementById("start")!.addEventListener("click", () => {
  void (async () => {
    await persist();
    const res = (await chrome.runtime.sendMessage({
      kind: "flowguard:start",
      tabId: await activeTabId(),
      apiUrl: $("apiUrl").value,
      token: $("token").value,
      projectId: $("projectId").value,
      flowName: $("flowName").value,
    })) as { ok: boolean; degraded: boolean; error?: string };
    statusEl().textContent = res.ok
      ? `recording started${res.degraded ? " (degraded — another debugger is attached)" : ""}`
      : `failed: ${res.error}`;
  })();
});

document.getElementById("stop")!.addEventListener("click", () => {
  void (async () => {
    statusEl().textContent = "uploading…";
    const res = (await chrome.runtime.sendMessage({ kind: "flowguard:stop" })) as {
      ok: boolean;
      recordingId?: string;
      events?: number;
      error?: string;
    };
    statusEl().textContent = res.ok
      ? `uploaded ✓ ${res.events} events → ${res.recordingId}`
      : `upload failed: ${res.error}`;
  })();
});

document.getElementById("mark")!.addEventListener("click", () => {
  void (async () => {
    await chrome.runtime.sendMessage({ kind: "flowguard:mark-assertion" });
    await refreshStatus();
    statusEl().textContent += " · assertion marked";
  })();
});

void restore();
setInterval(() => void refreshStatus(), 1500);
