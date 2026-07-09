import { describe, expect, it } from "vitest";
import { FlowSpecSchema, RunFlowResultSchema, type FlowSpec, type RunFlowResult } from "@flowguard/schemas";
import { isRecognizedTestCard, normalizeCardNumber } from "../src/payments.js";
import { compareFlow } from "../src/orchestrator/comparator.js";
import { buildConfigBundle } from "../src/orchestrator/config-bundle.js";
import { FakeStore } from "./fakes.js";
import type { Store } from "../src/store.js";

describe("test-card soft validation (doc 07 §6)", () => {
  it("recognizes Stripe documented test cards, with separators", () => {
    expect(isRecognizedTestCard("4242 4242 4242 4242", "stripe")).toBe(true);
    expect(isRecognizedTestCard("4000-0027-6000-3155", "stripe")).toBe(true);
    expect(isRecognizedTestCard("378282246310005", "stripe")).toBe(true);
  });

  it("rejects unknown numbers (the real-card hazard)", () => {
    expect(isRecognizedTestCard("4111111111111111", "stripe")).toBe(false);
    expect(isRecognizedTestCard("1234567812345678", "stripe")).toBe(false);
  });

  it("normalizes spaces and dashes", () => {
    expect(normalizeCardNumber("4242 4242-4242 4242")).toBe("4242424242424242");
  });
});

// ── the webhook-attribution rule (doc 05 §3.5) ─────────────────────────────
const paidSpec: FlowSpec = FlowSpecSchema.parse({
  specVersion: 3,
  flowId: "flw_buy",
  projectId: "prj_1",
  name: "Buy & Rip",
  startPath: "/shop",
  steps: [
    {
      id: "s1",
      title: "Click Buy Pack",
      action: { type: "click", locators: [{ kind: "testid", value: "buy-pack-btn" }, { kind: "text", value: "Buy" }] },
      settle: { strategy: "navigation", timeoutMs: 15000 },
      postConditions: [],
    },
    {
      id: "s2",
      title: "Complete payment (Stripe test mode)",
      action: { type: "payment", provider: "stripe", variant: "card", configRef: "project" },
      settle: { strategy: "navigation", timeoutMs: 30000 },
      postConditions: [],
    },
    {
      id: "s3",
      title: "Rip open the pack",
      action: { type: "click", locators: [{ kind: "testid", value: "pack" }, { kind: "css", value: "canvas" }] },
      settle: { strategy: "networkidle", timeoutMs: 8000 },
      postConditions: [
        { kind: "dom", assert: "textMatches", locators: [{ kind: "testid", value: "packs-remaining" }], value: "^0$" },
      ],
      caveats: ["webhook_dependent"],
    },
  ],
});

function paidResult(status: "passed" | "failed", failedStepId: string | null): RunFlowResult {
  return RunFlowResultSchema.parse({
    runId: "run_x",
    flowId: "flw_buy",
    specVersionId: "fsv_1",
    target: "head",
    status,
    failedStepId,
    failureClass: status === "failed" ? "assertion" : null,
    steps: [
      { id: "s1", durationMs: 400, settleMs: 50, network: [], screenshot: null, assertions: [] },
      { id: "s2", durationMs: 4000, settleMs: 900, network: [], screenshot: null, assertions: [] },
      ...(failedStepId === "s3"
        ? [{ id: "s3", durationMs: 8000, settleMs: 8000, network: [], screenshot: null, assertions: [{ kind: "dom", pass: false, message: 'text "1" !~ /^0$/' }] }]
        : []),
    ],
  });
}

const link = (k: string, l: string) => `[${l}](${k})`;
const basePass = RunFlowResultSchema.parse({
  runId: "run_x",
  flowId: "flw_buy",
  specVersionId: "fsv_1",
  target: "base",
  status: "passed",
});

describe("webhook attribution (doc 05 §3.5)", () => {
  it("payment succeeded + caveatted state assertion failed + unrelated diff → 🟣 webhook copy, not 🔴", () => {
    const c = compareFlow({
      spec: paidSpec,
      head: paidResult("failed", "s3"),
      base: basePass,
      baseAvailable: true,
      link,
      changedFiles: ["src/app/inventory/page.tsx"],
    });
    expect(c.verdict).toBe("env_issue");
    expect(c.detail).toContain("commonly a payment webhook not configured for preview URLs");
  });

  it("diff touches purchase code → stays 🔴 (the PR is a suspect)", () => {
    const c = compareFlow({
      spec: paidSpec,
      head: paidResult("failed", "s3"),
      base: basePass,
      baseAvailable: true,
      link,
      changedFiles: ["src/app/api/packs/confirm/route.ts"],
    });
    expect(c.verdict).toBe("broken");
  });

  it("failure AT the payment step → not webhook-attributed", () => {
    const head = RunFlowResultSchema.parse({
      ...paidResult("failed", "s2"),
      failedStepId: "s2",
    });
    const c = compareFlow({ spec: paidSpec, head, base: basePass, baseAvailable: true, link, changedFiles: [] });
    expect(c.verdict).toBe("broken");
  });

  it("payment_unverified_env (the live-mode guard) → 🟣 with the skip copy", () => {
    const head = RunFlowResultSchema.parse({
      ...paidResult("failed", "s2"),
      failureClass: "payment_unverified_env",
    });
    const c = compareFlow({ spec: paidSpec, head, base: basePass, baseAvailable: true, link });
    expect(c.verdict).toBe("env_issue");
    expect(c.detail).toContain("could not verify test mode");
  });
});

describe("config bundle payment resolution (doc 07 §3 hierarchy)", () => {
  async function bundleFor(prNumber: number | null) {
    const store = new FakeStore();
    await store.createPaymentConfig({
      projectId: "prj_1",
      scope: "project",
      prNumber: null,
      provider: "stripe",
      cardSecretId: "sec_card_project",
      expiry: "12 / 34",
      cvcSecretId: "sec_cvc_project",
      extras: {},
      testCardRecognized: true,
    });
    await store.createPaymentConfig({
      projectId: "prj_1",
      scope: "pr",
      prNumber: 42,
      provider: "stripe",
      cardSecretId: "sec_card_pr42",
      expiry: "11 / 33",
      cvcSecretId: "sec_cvc_pr42",
      extras: {},
      testCardRecognized: true,
    });
    return buildConfigBundle(
      { store: store as unknown as Store, projectId: "prj_1", prNumber, deploymentId: null, loginSpec: null },
      paidSpec,
    );
  }

  it("head with a PR override → PR-scoped card", async () => {
    const b = await bundleFor(42);
    expect(b.payment).toMatchObject({ cardRef: "sec_card_pr42", source: "pr" });
  });

  it("base (prNumber null) → project default, always", async () => {
    const b = await bundleFor(null);
    expect(b.payment).toMatchObject({ cardRef: "sec_card_project", source: "project" });
  });

  it("no config at all → payment null (runner fails the step closed)", async () => {
    const store = new FakeStore();
    const b = await buildConfigBundle(
      { store: store as unknown as Store, projectId: "prj_1", prNumber: null, deploymentId: null, loginSpec: null },
      paidSpec,
    );
    expect(b.payment).toBeNull();
  });
});
