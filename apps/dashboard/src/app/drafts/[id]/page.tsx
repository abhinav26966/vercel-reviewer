"use client";

import { use, useEffect, useState } from "react";
import { API_URL, api } from "@/lib/api";

interface Assertion {
  kind: string;
  [key: string]: unknown;
}

interface Step {
  id: string;
  title: string;
  intent?: string;
  action: { type: string; [key: string]: unknown };
  settle: { strategy: string; timeoutMs: number };
  postConditions: Assertion[];
}

interface Draft {
  id: string;
  flowId: string;
  status: string;
  spec: {
    name: string;
    description?: string;
    persona: string | null;
    startPath: string;
    steps: Step[];
    [key: string]: unknown;
  };
  compilationReport: {
    needsAttention?: Array<{ stepId: string | null; message: string }>;
    rejectedSuggestions?: Array<{ stepId: string; reason: string }>;
    loginReplacement?: { persona: string; replacedEventIds: string[] } | null;
  } | null;
  stepScreenshots: Record<string, string>;
}

function assertionLabel(a: Assertion): string {
  switch (a.kind) {
    case "dom":
      return `dom ${a.assert}: ${JSON.stringify(a.locators)}${a.value !== undefined ? ` ~ ${a.value}` : ""}`;
    case "url":
      return `url ${a.assert}: ${a.value}`;
    case "delta":
      return `delta ${a.metric} ${a.assert} ${a.value}`;
    case "vision":
      return `vision: "${a.question}" == ${a.value}`;
    default:
      return `${a.kind}`;
  }
}

export default function DraftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string>("");

  useEffect(() => {
    api<Draft>(`/api/drafts/${id}`)
      .then(setDraft)
      .catch((e) => setStatus(String(e)));
  }, [id]);

  if (!draft) return <main><p className="muted">{status || "loading…"}</p></main>;

  const attention = draft.compilationReport?.needsAttention ?? [];

  async function confirm() {
    setStatus("confirming…");
    const spec = structuredClone(draft!.spec);
    for (const step of spec.steps) {
      if (titles[step.id]) step.title = titles[step.id]!;
      step.postConditions = step.postConditions.filter(
        (_, i) => !excluded.has(`${step.id}:${i}`),
      );
    }
    try {
      const res = await api<{ versionId: string }>(`/api/drafts/${draft!.id}/confirm`, {
        method: "POST",
        body: JSON.stringify({ spec }),
      });
      setStatus(`confirmed ✓ — validation running as version ${res.versionId}`);
    } catch (err) {
      setStatus(String(err));
    }
  }

  return (
    <main>
      <h1>
        Review draft: {draft.spec.name} <span className="pill">{draft.status}</span>
      </h1>
      <p className="muted">
        persona: {draft.spec.persona ?? "none"} · starts at {draft.spec.startPath} ·{" "}
        {draft.compilationReport?.loginReplacement
          ? `login steps replaced with persona "${draft.compilationReport.loginReplacement.persona}"`
          : "no login detected"}
      </p>
      {attention.length > 0 ? (
        <div className="card" style={{ borderColor: "#9e6a03", margin: "1rem 0" }}>
          <strong>⚠ needs attention</strong>
          {attention.map((n, i) => (
            <p className="muted" key={i}>
              {n.stepId ? `${n.stepId}: ` : ""}
              {n.message}
            </p>
          ))}
        </div>
      ) : null}

      {draft.spec.steps.map((step) => (
        <div className="card" style={{ margin: "1rem 0" }} key={step.id} data-testid={`step-${step.id}`}>
          <div style={{ display: "flex", gap: "1rem" }}>
            <div style={{ flex: 1 }}>
              <input
                defaultValue={step.title}
                data-testid={`title-${step.id}`}
                style={{ fontWeight: 600, width: "100%" }}
                onChange={(e) => setTitles({ ...titles, [step.id]: e.target.value })}
              />
              {step.intent ? <p className="muted">{step.intent}</p> : null}
              <p className="muted">
                {step.action.type} · settle {step.settle.strategy} ({step.settle.timeoutMs}ms)
              </p>
              <ul style={{ listStyle: "none", marginTop: 8 }}>
                {step.postConditions.map((a, i) => (
                  <li key={i}>
                    <label>
                      <input
                        type="checkbox"
                        defaultChecked
                        data-testid={`assert-${step.id}-${i}`}
                        onChange={(e) => {
                          const next = new Set(excluded);
                          const key = `${step.id}:${i}`;
                          if (e.target.checked) next.delete(key);
                          else next.add(key);
                          setExcluded(next);
                        }}
                      />{" "}
                      <code style={{ fontSize: "0.8rem" }}>{assertionLabel(a)}</code>
                    </label>
                  </li>
                ))}
                {step.postConditions.length === 0 ? <li className="muted">no assertions</li> : null}
              </ul>
            </div>
            {draft.stepScreenshots[step.id] ? (
              <img
                src={`${API_URL}${draft.stepScreenshots[step.id]}`}
                alt={step.id}
                style={{ width: 280, borderRadius: 6, border: "1px solid #30363d", alignSelf: "flex-start" }}
              />
            ) : null}
          </div>
        </div>
      ))}

      <button onClick={() => void confirm()} data-testid="confirm-draft">
        Confirm & validate against base
      </button>
      <p className="muted" data-testid="confirm-status">{status}</p>
    </main>
  );
}
