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

interface DraftRow {
  id: string;
  flowName: string;
  branch: string;
}

interface RecordingRow {
  id: string;
  flowName: string | null;
  status: string;
}

interface RunRow {
  id: string;
  kind: string;
  state: string;
  headSha: string | null;
  branch: string | null;
  prNumber: number | null;
}

interface FlowRow {
  id: string;
  name: string;
  tier: string;
  archived: boolean;
}

interface AwaitingVerdict {
  id: string;
  runId: string;
  flowId: string;
  flowName: string;
  humanCopy: string;
  rationale: string | null;
}

interface HealPatch {
  resultId: string;
  runId: string;
  flowId: string;
  flowName: string;
  patch: unknown;
}

interface AlertRow {
  id: string;
  kind: string;
  payload: { flowName?: string; message?: string; flowId?: string };
  createdAt: string;
}

interface PaymentConfigRow {
  id: string;
  scope: string;
  prNumber: number | null;
  provider: string;
  cardLast4: string | null;
  expiry: string | null;
  testCardRecognized: boolean;
}

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [creds, setCreds] = useState<CredentialSet[]>([]);
  const [flows, setFlows] = useState<FlowRow[]>([]);
  const [awaiting, setAwaiting] = useState<AwaitingVerdict[]>([]);
  const [healPatches, setHealPatches] = useState<HealPatch[]>([]);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [paymentConfigs, setPaymentConfigs] = useState<PaymentConfigRow[]>([]);
  const [payForm, setPayForm] = useState({ scope: "project", prNumber: "", card: "", expiry: "", cvc: "", consent: false });
  const [payWarning, setPayWarning] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [recordings, setRecordings] = useState<RecordingRow[]>([]);
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
    api<FlowRow[]>(`/api/projects/${id}/flows`).then(setFlows).catch(() => {});
    api<AwaitingVerdict[]>(`/api/projects/${id}/verdicts`).then(setAwaiting).catch(() => {});
    api<HealPatch[]>(`/api/projects/${id}/heal-patches`).then(setHealPatches).catch(() => {});
    api<AlertRow[]>(`/api/projects/${id}/alerts`).then(setAlerts).catch(() => {});
    api<PaymentConfigRow[]>(`/api/projects/${id}/payment-configs`).then(setPaymentConfigs).catch(() => {});
    api<RunRow[]>(`/api/projects/${id}/runs`).then(setRuns).catch(() => {});
    api<DraftRow[]>(`/api/projects/${id}/drafts`).then(setDrafts).catch(() => {});
    api<RecordingRow[]>(`/api/projects/${id}/recordings`).then(setRecordings).catch(() => {});
  }, [id]);
  useEffect(refresh, [refresh]);

  async function submitPayment(confirmUnrecognized: boolean) {
    setError(null);
    try {
      await api(`/api/projects/${id}/payment-configs`, {
        method: "POST",
        body: JSON.stringify({
          provider: "stripe",
          scope: payForm.scope,
          prNumber: payForm.scope === "pr" ? Number(payForm.prNumber) : undefined,
          card: payForm.card,
          expiry: payForm.expiry,
          cvc: payForm.cvc,
          consent: payForm.consent,
          confirmUnrecognized,
        }),
      });
      setPayWarning(null);
      setPayForm({ ...payForm, card: "", cvc: "" });
      refresh();
    } catch (err) {
      const msg = String(err);
      if (msg.includes("requiresConfirmation") || msg.includes("known test card")) {
        setPayWarning("this doesn't look like a known test card — if it's a real card, remove it now");
      } else {
        setError(msg);
      }
    }
  }

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

      {alerts.length > 0 ? (
        <>
          <h2>🚨 Alerts</h2>
          <table>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id}>
                  <td>
                    <span className="pill">{a.kind}</span> {a.payload.message ?? a.payload.flowName ?? ""}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button
                      data-testid={`ack-${a.id}`}
                      onClick={async () => {
                        await api(`/api/projects/${id}/alerts/ack`, {
                          method: "POST",
                          body: JSON.stringify({ kind: a.kind, flowId: a.payload.flowId }),
                        });
                        refresh();
                      }}
                    >
                      acknowledge
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      {awaiting.length > 0 ? (
        <>
          <h2>🔵 Changed as intended — awaiting your decision</h2>
          <table>
            <tbody>
              {awaiting.map((v) => (
                <tr key={v.id}>
                  <td>
                    <strong>{v.flowName}</strong>
                    <br />
                    {v.humanCopy}
                    {v.rationale ? <p className="muted">{v.rationale}</p> : null}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button
                      data-testid={`approve-${v.id}`}
                      onClick={async () => {
                        await api(`/api/verdicts/${v.id}/approve`, { method: "POST", body: "{}" });
                        refresh();
                      }}
                    >
                      ✔ Approve new behavior
                    </button>{" "}
                    <button
                      className="danger"
                      data-testid={`reject-${v.id}`}
                      onClick={async () => {
                        await api(`/api/verdicts/${v.id}/reject`, { method: "POST", body: "{}" });
                        refresh();
                      }}
                    >
                      ✖ Reject (→ 🔴)
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      {healPatches.length > 0 ? (
        <>
          <h2>Spec drift detected</h2>
          <table>
            <tbody>
              {healPatches.map((p) => (
                <tr key={p.resultId}>
                  <td>
                    <strong>{p.flowName}</strong> — a step succeeded via adaptive retry; accept the updated
                    locator?
                    <p className="muted" style={{ fontFamily: "monospace", fontSize: 12 }}>
                      {JSON.stringify(p.patch).slice(0, 160)}
                    </p>
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button
                      data-testid={`accept-patch-${p.resultId}`}
                      onClick={async () => {
                        await api(`/api/heal-patches/accept`, {
                          method: "POST",
                          body: JSON.stringify({ runId: p.runId, flowId: p.flowId }),
                        });
                        refresh();
                      }}
                    >
                      Accept updated locator
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      <h2>Flows</h2>
      <table>
        <thead>
          <tr>
            <th>Flow</th>
            <th>Tier</th>
            <th>Smoke (always runs)</th>
          </tr>
        </thead>
        <tbody>
          {flows.map((f) => (
            <tr key={f.id} style={f.archived ? { opacity: 0.5 } : undefined}>
              <td>
                {f.name}
                {f.archived ? <span className="pill"> archived</span> : null}
              </td>
              <td>
                <span className="pill">{f.tier}</span>
              </td>
              <td>
                <input
                  type="checkbox"
                  data-testid={`smoke-${f.id}`}
                  checked={f.tier === "smoke"}
                  onChange={async (e) => {
                    await api(`/api/flows/${f.id}/tier`, {
                      method: "PATCH",
                      body: JSON.stringify({ tier: e.target.checked ? "smoke" : "standard" }),
                    });
                    refresh();
                  }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Payments</h2>
      <p className="muted">
        Configuring payments acknowledges that FlowGuard will execute checkout flows against your payment
        provider&apos;s <strong>test mode</strong>. The live-mode guard is independent of this config and always
        fails closed.
      </p>
      <table>
        <tbody>
          {paymentConfigs.map((p) => (
            <tr key={p.id}>
              <td>
                <span className="pill">{p.provider}</span>{" "}
                <span className="pill">{p.scope === "pr" ? `PR #${p.prNumber}` : "project default"}</span> card
                …{p.cardLast4 ?? "????"} exp {p.expiry}
                {!p.testCardRecognized ? <strong> ⚠ unrecognized card</strong> : null}
              </td>
              <td>
                <button
                  className="danger"
                  onClick={async () => {
                    await api(`/api/payment-configs/${p.id}`, { method: "DELETE" });
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
      {payWarning ? (
        <p className="error" data-testid="payment-warning">
          ⚠ {payWarning} —{" "}
          <button
            data-testid="payment-confirm-unrecognized"
            onClick={async () => {
              await submitPayment(true);
            }}
          >
            I confirm this is NOT a real card
          </button>
        </p>
      ) : null}
      <form
        className="row"
        data-testid="payment-form"
        onSubmit={async (e) => {
          e.preventDefault();
          await submitPayment(false);
        }}
      >
        <select value={payForm.scope} onChange={(e) => setPayForm({ ...payForm, scope: e.target.value })}>
          <option value="project">project default</option>
          <option value="pr">PR-scoped</option>
        </select>
        {payForm.scope === "pr" ? (
          <input
            placeholder="PR #"
            style={{ width: 70 }}
            value={payForm.prNumber}
            onChange={(e) => setPayForm({ ...payForm, prNumber: e.target.value })}
          />
        ) : null}
        <input
          placeholder="test card number"
          data-testid="pay-card"
          value={payForm.card}
          onChange={(e) => setPayForm({ ...payForm, card: e.target.value })}
        />
        <input
          placeholder="MM / YY"
          data-testid="pay-expiry"
          style={{ width: 90 }}
          value={payForm.expiry}
          onChange={(e) => setPayForm({ ...payForm, expiry: e.target.value })}
        />
        <input
          placeholder="CVC"
          data-testid="pay-cvc"
          style={{ width: 60 }}
          value={payForm.cvc}
          onChange={(e) => setPayForm({ ...payForm, cvc: e.target.value })}
        />
        <label style={{ whiteSpace: "nowrap" }}>
          <input
            type="checkbox"
            data-testid="pay-consent"
            checked={payForm.consent}
            onChange={(e) => setPayForm({ ...payForm, consent: e.target.checked })}
          />{" "}
          I consent to test-mode checkout runs
        </label>
        <button type="submit" data-testid="pay-save">
          Save
        </button>
      </form>

      <h2>Recordings & drafts</h2>
      <table>
        <tbody>
          {recordings.map((r) => (
            <tr key={r.id}>
              <td>{r.flowName ?? r.id}</td>
              <td><span className="pill">{r.status}</span></td>
              <td className="muted">{r.id}</td>
            </tr>
          ))}
          {drafts.map((d) => (
            <tr key={d.id}>
              <td>
                <Link href={`/drafts/${d.id}`} data-testid={`draft-${d.id}`}>
                  review draft: {d.flowName}
                </Link>
              </td>
              <td><span className="pill">draft</span></td>
              <td className="muted">{d.branch}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>
        Runs{" "}
        <button
          data-testid="run-base-suite"
          onClick={async () => {
            await api(`/api/projects/${id}/base-run`, { method: "POST", body: JSON.stringify({ branch: "main" }) });
            refresh();
          }}
        >
          ▶ Run base suite now
        </button>
      </h2>
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
