"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { initFlowState, setFlowState } from "./flow-state";

// The r3f scene touches WebGL/window — client-only.
const PackScene = dynamic(() => import("./PackScene"), {
  ssr: false,
  loading: () => <p className="muted">Loading 3D scene…</p>,
});

export type OpenPhase = "idle" | "ripping" | "revealed";

export default function OpenClient({
  initialPacks,
  breakFlag,
}: {
  initialPacks: number;
  breakFlag: string | null;
}) {
  const [phase, setPhase] = useState<OpenPhase>("idle");
  const [packs, setPacks] = useState(initialPacks);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    initFlowState();
  }, []);

  async function handlePackClick() {
    if (phase !== "idle" || busy.current) return;
    busy.current = true;
    setError(null);
    try {
      const qs = breakFlag ? `?break=${encodeURIComponent(breakFlag)}` : "";
      const res = await fetch(`/api/packs/open${qs}`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `Failed to open pack (HTTP ${res.status})`);
        return;
      }
      const data = (await res.json()) as { packs: number };
      setPacks(data.packs);
      setPhase("ripping");
    } catch {
      setError("Failed to open pack (network error)");
    } finally {
      busy.current = false;
    }
  }

  function handleRipComplete() {
    setFlowState({ packOpened: true });
    setPhase("revealed");
  }

  return (
    <div>
      <p className="muted">
        Unopened packs: <span data-testid="packs-remaining">{packs}</span>
        {packs === 0 && phase === "idle" ? (
          <span data-testid="no-packs"> — buy one in the shop first.</span>
        ) : phase === "idle" ? (
          <span> — click the glowing pack to rip it open.</span>
        ) : null}
      </p>
      {error ? (
        <p className="error" data-testid="open-error">
          {error}
        </p>
      ) : null}
      <div className="canvas-wrap">
        <PackScene phase={phase} onPackClick={handlePackClick} onRipComplete={handleRipComplete} />
      </div>
      {phase === "revealed" ? (
        <div className="grid" data-testid="revealed-cards">
          {Array.from({ length: 5 }, (_, i) => (
            <div className="pack-tile" data-testid="revealed-card" key={i}>
              <h3>Card {i + 1}</h3>
              <p className="muted">revealed</p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// force rebuild (sdk off)
