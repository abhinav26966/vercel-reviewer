"use client";

import { use, useEffect, useState } from "react";
import { API_URL, api } from "@/lib/api";

interface RunDetail {
  run: { id: string; kind: string; state: string; headSha: string | null };
  results: Array<{
    id: string;
    flowId: string;
    target: string;
    status: string;
    failureClass: string | null;
    failedStepId: string | null;
    fromCache: boolean;
    artifactLinks: Record<string, string>;
  }>;
  verdicts: Array<{ flowId: string; verdict: string; humanCopy: string }>;
}

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<RunDetail>(`/api/runs/${id}`).then(setDetail).catch((e) => setError(String(e)));
  }, [id]);

  if (error) return <main><p className="error">{error}</p></main>;
  if (!detail) return <main><p className="muted">loading…</p></main>;

  return (
    <main>
      <h1>
        Run {detail.run.id.slice(0, 16)} <span className="pill">{detail.run.state}</span>
      </h1>
      <p className="muted">
        {detail.run.kind} · head {detail.run.headSha?.slice(0, 7) ?? "—"}
      </p>

      <h2>Verdicts</h2>
      <table>
        <tbody>
          {detail.verdicts.map((v) => (
            <tr key={v.flowId}>
              <td>{v.flowId}</td>
              <td>
                <span className="pill">{v.verdict}</span>
              </td>
              <td className="muted">{v.humanCopy.slice(0, 120)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Flow results & artifacts</h2>
      <table>
        <thead>
          <tr>
            <th>Flow</th>
            <th>Target</th>
            <th>Status</th>
            <th>Failed step</th>
            <th>Cache</th>
            <th>Artifacts</th>
          </tr>
        </thead>
        <tbody>
          {detail.results.map((r) => (
            <tr key={r.id}>
              <td>{r.flowId}</td>
              <td>{r.target}</td>
              <td>
                <span className="pill">{r.status}</span>
              </td>
              <td>{r.failedStepId ?? "—"}</td>
              <td>{r.fromCache ? "hit" : "—"}</td>
              <td>
                {Object.entries(r.artifactLinks).map(([name, href]) => (
                  <a key={name} href={`${API_URL}${href}`} target="_blank" style={{ marginRight: 8 }}>
                    {name}
                  </a>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
