"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

interface CredentialSet {
  id: string;
  scope: "project" | "pr";
  prNumber: number | null;
  persona: string;
  usernameLast4: string | null;
  dataBranchDiffers: boolean;
}

interface RunRow {
  id: string;
  kind: string;
  state: string;
  headSha: string | null;
  branch: string | null;
  prNumber: number | null;
}

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [creds, setCreds] = useState<CredentialSet[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    scope: "project",
    prNumber: "",
    persona: "default",
    username: "",
    password: "",
  });

  const refresh = useCallback(() => {
    api<CredentialSet[]>(`/api/projects/${id}/credentials`).then(setCreds).catch((e) => setError(String(e)));
    api<RunRow[]>(`/api/projects/${id}/runs`).then(setRuns).catch(() => {});
  }, [id]);
  useEffect(refresh, [refresh]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/api/projects/${id}/credentials`, {
        method: "POST",
        body: JSON.stringify({
          scope: form.scope,
          prNumber: form.scope === "pr" ? Number(form.prNumber) : undefined,
          persona: form.persona,
          username: form.username,
          password: form.password,
        }),
      });
      setForm({ ...form, username: "", password: "" });
      refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <main>
      <h1>Project {id}</h1>
      {error ? <p className="error">{error}</p> : null}

      <h2>Credentials</h2>
      <table>
        <thead>
          <tr>
            <th>Persona</th>
            <th>Scope</th>
            <th>Username</th>
            <th>DB differs</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {creds.map((c) => (
            <tr key={c.id}>
              <td>{c.persona}</td>
              <td>
                <span className="pill">{c.scope === "pr" ? `PR #${c.prNumber}` : "project default"}</span>
              </td>
              <td>…{c.usernameLast4 ?? "????"}</td>
              <td>{c.dataBranchDiffers ? "yes" : "no"}</td>
              <td>
                <button
                  className="danger"
                  onClick={async () => {
                    await api(`/api/credentials/${c.id}`, { method: "DELETE" });
                    refresh();
                  }}
                >
                  delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form className="row" onSubmit={submit} data-testid="credentials-form">
        <select
          value={form.scope}
          data-testid="cred-scope"
          onChange={(e) => setForm({ ...form, scope: e.target.value })}
        >
          <option value="project">project default</option>
          <option value="pr">PR-scoped</option>
        </select>
        {form.scope === "pr" ? (
          <input
            placeholder="PR #"
            data-testid="cred-pr"
            style={{ width: 70 }}
            value={form.prNumber}
            onChange={(e) => setForm({ ...form, prNumber: e.target.value })}
          />
        ) : null}
        <input
          placeholder="persona"
          data-testid="cred-persona"
          style={{ width: 110 }}
          value={form.persona}
          onChange={(e) => setForm({ ...form, persona: e.target.value })}
        />
        <input
          placeholder="username / email"
          data-testid="cred-username"
          value={form.username}
          onChange={(e) => setForm({ ...form, username: e.target.value })}
        />
        <input
          placeholder="password"
          type="password"
          data-testid="cred-password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
        <button type="submit" data-testid="cred-save">
          Save
        </button>
      </form>

      <h2>Runs</h2>
      <table>
        <thead>
          <tr>
            <th>Run</th>
            <th>Kind</th>
            <th>PR</th>
            <th>SHA</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>
                <Link href={`/runs/${r.id}`}>{r.id.slice(0, 16)}</Link>
              </td>
              <td>{r.kind}</td>
              <td>{r.prNumber ? `#${r.prNumber}` : r.branch ?? "—"}</td>
              <td>{r.headSha?.slice(0, 7) ?? "—"}</td>
              <td>
                <span className="pill">{r.state}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
