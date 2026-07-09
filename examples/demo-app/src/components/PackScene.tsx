"use client";

// r3f scene: the glowing pack the user rips open

import { Canvas, useFrame } from "@react-three/fiber";
import { useRef, useState } from "react";
import * as THREE from "three";
import type { OpenPhase } from "./OpenClient";
import { setFlowState } from "./flow-state";

const CARD_COLORS = ["#e05252", "#52a7e0", "#5ee068", "#e0c052", "#b06ee0"];
const RIP_DURATION = 0.9; // seconds of pack burst animation
const CARD_REVEAL_EVERY = 0.3; // seconds between card reveals

function Pack({
  phase,
  onClick,
  onRipComplete,
}: {
  phase: OpenPhase;
  onClick: () => void;
  onRipComplete: () => void;
}) {
  const mesh = useRef<THREE.Mesh>(null);
  const ripStart = useRef<number | null>(null);
  const completed = useRef(false);

  useFrame((state, delta) => {
    const m = mesh.current;
    if (!m) return;
    if (phase === "idle") {
      // gentle idle spin + bob so the scene is visibly "alive"
      m.rotation.y += delta * 0.7;
      m.position.y = Math.sin(state.clock.elapsedTime * 1.6) * 0.1;
    } else if (phase === "ripping") {
      if (ripStart.current === null) ripStart.current = state.clock.elapsedTime;
      const t = state.clock.elapsedTime - ripStart.current;
      if (t < RIP_DURATION) {
        // burst: spin fast, swell, then shrink away
        m.rotation.y += delta * 14;
        const swell = t < 0.4 ? 1 + t * 1.5 : Math.max(0, 1.6 * (1 - (t - 0.4) / 0.5));
        m.scale.setScalar(swell);
      } else if (!completed.current) {
        completed.current = true;
        m.visible = false;
        onRipComplete();
      }
    }
  });

  if (phase === "revealed") return null;

  return (
    <mesh ref={mesh} onClick={onClick} name="pack">
      <boxGeometry args={[1.5, 2.1, 0.3]} />
      <meshStandardMaterial color="#d4af37" emissive="#a67c00" emissiveIntensity={0.8} />
    </mesh>
  );
}

function Cards() {
  const [revealed, setRevealed] = useState(0);
  const start = useRef<number | null>(null);

  useFrame((state) => {
    if (start.current === null) start.current = state.clock.elapsedTime;
    const t = state.clock.elapsedTime - start.current;
    const target = Math.min(CARD_COLORS.length, Math.floor(t / CARD_REVEAL_EVERY) + 1);
    if (target > revealed) {
      setRevealed(target);
      setFlowState({ cardsRevealed: target });
    }
  });

  return (
    <group name="cards">
      {CARD_COLORS.slice(0, revealed).map((color, i) => (
        <mesh
          key={color}
          position={[(i - 2) * 1.05, 0, 0.2 + i * 0.01]}
          rotation={[0, 0, (i - 2) * -0.08]}
        >
          <planeGeometry args={[0.9, 1.35]} />
          <meshStandardMaterial color={color} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </group>
  );
}

export default function PackScene({
  phase,
  onPackClick,
  onRipComplete,
}: {
  phase: OpenPhase;
  onPackClick: () => void;
  onRipComplete: () => void;
}) {
  return (
    <Canvas
      camera={{ position: [0, 0, 5], fov: 50 }}
      onCreated={({ gl }) => {
        // the runner's canvasLocator resolves the real <canvas> element (doc 02 §2 s4)
        gl.domElement.setAttribute("data-testid", "pack-canvas");
      }}
    >
      <ambientLight intensity={0.6} />
      <directionalLight position={[3, 4, 5]} intensity={1.4} />
      <pointLight position={[0, 0, 3]} intensity={2.5} color="#ffd700" />
      <Pack phase={phase} onClick={onPackClick} onRipComplete={onRipComplete} />
      {phase === "revealed" ? <Cards /> : null}
    </Canvas>
  );
}
