import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { pino } from "pino";
import type { RecordingTrace } from "@flowguard/schemas";
import type { InferenceProvider } from "@flowguard/inference";
import { normalizeTrace } from "../src/compiler/normalize.js";
import { detectLogin } from "../src/compiler/detect.js";
import { assembleSpec, collectKnownTestIds } from "../src/compiler/assemble.js";
import { compileRecording } from "../src/compiler/compile.js";
import type { StepSuggestion } from "../src/compiler/vision-pass.js";
import { FakeStore } from "./fakes.js";

/** A miniature of the real Phase 5 recording: login → shop → buy → open → canvas rip. */
function buyRipTrace(): RecordingTrace {
  const target = (tag: string, testid: string, extra: Record<string, unknown> = {}) => ({
    tag,
    locators: [
      { kind: "testid" as const, value: testid },
      { kind: "css" as const, value: `[data-testid="${testid}"]` },
    ],
    a11y: { role: tag === "button" ? "button" : "textbox", name: testid, path: [] },
    boundingBox: { x: 0, y: 0, w: 10, h: 10 },
    isCanvas: false,
    canvasRelative: null,
    ...extra,
  });
  const ev = (id: string, ts: number, type: string, url: string, rest: Record<string, unknown> = {}) => ({
    id,
    ts,
    type,
    url: `https://demo.vercel.app${url}`,
    target: null,
    value: null,
    screenshotBefore: "shots/start.jpg",
    screenshotAfter: "shots/start.jpg",
    domSnapshotAfter: "dom/snap.json",
    network: [],
    ...rest,
  });
  return {
    traceVersion: 1,
    recordedAt: "2026-07-08T12:00:00Z",
    origin: "https://demo.vercel.app",
    viewport: { width: 1280, height: 720, dpr: 1 },
    userAgent: "test",
    assertionMarkers: [],
    consoleErrors: [],
    finalScreenshot: null,
    events: [
      ev("e1", 100, "input", "/login", { target: target("input", "email-input"), value: "default@demo.dev" }),
      ev("e2", 300, "input", "/login", { target: target("input", "password-input"), value: "«redacted:password»" }),
      ev("e3", 500, "click", "/login", { target: target("button", "login-submit") }),
      ev("e4", 900, "navigation", "/shop"),
      ev("e5", 2000, "click", "/shop", {
        target: target("button", "buy-pack-btn"),
        network: [{ method: "POST", url: "https://demo.vercel.app/api/packs/buy", status: 303, ttfbMs: 50, totalMs: 80, resourceType: "document" }],
      }),
      ev("e6", 2400, "navigation", "/shop/success"),
      ev("e7", 2450, "navigation", "/shop/success"), // dup (frameNavigated + withinDocument)
      ev("e8", 5000, "navigation", "/open"),
      ev("e9", 7000, "click", "/open", {
        target: {
          tag: "canvas",
          locators: [
            { kind: "testid" as const, value: "pack-canvas" },
            { kind: "css" as const, value: "canvas" },
          ],
          a11y: null,
          boundingBox: { x: 100, y: 100, w: 700, h: 480 },
          isCanvas: true,
          canvasRelative: { nx: 0.5, ny: 0.62 },
        },
        network: [{ method: "POST", url: "https://demo.vercel.app/api/packs/open", status: 200, ttfbMs: 60, totalMs: 90, resourceType: "fetch" }],
      }),
    ] as RecordingTrace["events"],
  } as RecordingTrace;
}

const outline = {
  tag: "body",
  children: [
    { tag: "button", testid: "buy-pack-btn" },
    { tag: "h1", role: "heading", name: "Purchase complete", testid: "purchase-complete" },
    { tag: "canvas", testid: "pack-canvas" },
    { tag: "span", testid: "packs-remaining" },
  ],
};

function suggestionsFor(events: { event: { id: string } }[]): Map<string, StepSuggestion> {
  const m = new Map<string, StepSuggestion>();
  const byId = Object.fromEntries(events.map((e, i) => [e.event.id, i]));
  m.set("e5", {
    index: byId["e5"]!,
    title: "Buy a pack",
    intent: "Purchase a pack from the shop",
    settle: "navigation",
    suggestedAssertions: [
      { kind: "dom-visible", testid: "purchase-complete", description: "success page shows" },
      { kind: "dom-visible", testid: "hallucinated-element", description: "made up" },
      { kind: "delta-count", testid: "packs-remaining", expected: 1 },
    ],
  });
  m.set("e9", {
    index: byId["e9"]!,
    title: "Rip open the pack",
    settle: "animationQuiescence",
    canvasTargetDescription: "the glowing card pack in the center of the 3D scene",
    suggestedAssertions: [
      { kind: "vision", question: "How many cards are revealed?", expected: 5 },
    ],
  });
  return m;
}

describe("normalizeTrace", () => {
  it("dedupes navigations, merges focus clicks, classifies consequences", () => {
    const res = normalizeTrace(buyRipTrace());
    const ids = res.events.map((e) => e.event.id);
    expect(ids).not.toContain("e7"); // dup navigation dropped
    const nav = res.events.find((e) => e.event.id === "e6");
    expect(nav?.consequenceOf).toBe("e5"); // buy → success nav is a consequence
    const isolated = res.events.find((e) => e.event.id === "e8");
    expect(isolated?.consequenceOf).toBeUndefined(); // /open was an explicit jump
  });
});

describe("detectLogin", () => {
  it("finds the login range and the resume point", () => {
    const res = normalizeTrace(buyRipTrace());
    const login = detectLogin(res.events);
    expect(login).not.toBeNull();
    expect(login!.replacedEventIds).toEqual(["e1", "e2", "e3", "e4"]);
    expect(login!.persona).toBe("default");
    expect(res.events[login!.resumeIndex]!.event.id).toBe("e5");
  });
});

describe("assembleSpec", () => {
  function assemble() {
    const trace = buyRipTrace();
    const normalized = normalizeTrace(trace);
    const login = detectLogin(normalized.events);
    return assembleSpec({
      trace,
      events: normalized.events,
      login,
      suggestions: suggestionsFor(normalized.events.slice(login!.resumeIndex)),
      flowMeta: { name: "Buy and rip", description: "Buys then opens a pack" },
      recordedFlowName: "Buy & Rip Open a Pack (recorded)",
      projectId: "prj_1",
      flowId: "flw_new",
      knownTestIds: collectKnownTestIds([outline]),
      dropped: normalized.dropped,
    });
  }

  it("replaces login with the persona and starts the flow at the post-login page", () => {
    const { spec, report } = assemble();
    expect(spec.persona).toBe("default");
    expect(spec.startPath).toBe("/shop");
    expect(JSON.stringify(spec.steps)).not.toContain("password");
    expect(report.loginReplacement?.replacedEventIds).toContain("e2");
  });

  it("builds steps from events with hardened locators, settle, and mapped assertions", () => {
    const { spec } = assemble();
    const [buy, goOpen, rip] = spec.steps;
    expect(buy!.action.type).toBe("click");
    expect(buy!.settle.strategy).toBe("navigation");
    expect(buy!.postConditions).toContainEqual({ kind: "url", assert: "pathMatches", value: "^/shop/success$" });
    expect(buy!.postConditions.some((a) => a.kind === "dom" && "locators" in a && JSON.stringify(a.locators).includes("purchase-complete"))).toBe(true);
    expect(buy!.postConditions.some((a) => a.kind === "delta")).toBe(true);

    expect(goOpen!.action.type).toBe("navigate");
    expect((goOpen!.action as { path: string }).path).toBe("/open");

    expect(rip!.action.type).toBe("canvasClick");
    expect((rip!.action as { point: { nx: number } }).point.nx).toBe(0.5);
    expect((rip!.action as { visionFallback?: { describe: string } }).visionFallback?.describe).toContain("glowing");
    expect(rip!.settle.strategy).toBe("animationQuiescence");
    expect(rip!.postConditions.some((a) => a.kind === "vision")).toBe(true);
  });

  it("hallucination guard: rejects assertions on testids never seen in the DOM", () => {
    const { spec, report } = assemble();
    expect(JSON.stringify(spec)).not.toContain("hallucinated-element");
    expect(report.rejectedSuggestions.some((r) => String(r.reason).includes("hallucinated-element"))).toBe(true);
  });

  it("every step references source events (guard) and user flow name wins", () => {
    const { spec, report } = assemble();
    for (const step of spec.steps) {
      expect(report.stepSourceEvents[step.id]!.length).toBeGreaterThan(0);
    }
    expect(spec.name).toBe("Buy & Rip Open a Pack (recorded)");
  });
});

describe("compileRecording (end-to-end with fake inference)", () => {
  it("compiles a bundle into a draft flow version", async () => {
    const store = new FakeStore();
    store.recordings.push({
      id: "rec_1",
      projectId: "prj_1",
      flowName: "Buy & Rip",
      traceKey: "recordings/rec_1/bundle.zip",
      origin: "https://demo.vercel.app",
      status: "uploaded",
    });
    const trace = buyRipTrace();
    const bundle = Buffer.from(
      zipSync({
        "trace.json": strToU8(JSON.stringify(trace)),
        "shots/start.jpg": new Uint8Array([1]),
        "dom/snap.json": strToU8(JSON.stringify(outline)),
      }),
    );
    const inference: InferenceProvider = {
      visionAnalyze: async <T,>(opts: { prompt: string }): Promise<{ result: T; usage: never }> => {
        if (opts.prompt.includes("start and end of a recorded user flow")) {
          return { result: { name: "Buy and rip", description: "d" } as T, usage: { model: "fake", promptTokens: 0, completionTokens: 0 } as never };
        }
        // step batch: title everything generically
        const indices = [...opts.prompt.matchAll(/STEP index=(\d+)/g)].map((m) => Number(m[1]));
        return {
          result: { steps: indices.map((index) => ({ index, title: `Step ${index}`, suggestedAssertions: [] })) } as T,
          usage: { model: "fake", promptTokens: 0, completionTokens: 0 } as never,
        };
      },
      groundElement: async () => ({ result: null, usage: { model: "fake", promptTokens: 0, completionTokens: 0 } }),
      judge: async () => {
        throw new Error("unused");
      },
    };

    const res = await compileRecording(
      { store, inference, getObject: async () => bundle, logger: pino({ level: "silent" }) },
      "rec_1",
    );
    expect(store.flowRows).toHaveLength(1);
    expect(store.versionRows[0]).toMatchObject({ status: "draft", source: "recording", flowId: res.flowId });
    expect(store.versionRows[0]!.spec.persona).toBe("default");
    expect(store.recordings[0]!.status).toBe("compiled");
  });

  it("marks the recording failed when compilation throws", async () => {
    const store = new FakeStore();
    store.recordings.push({
      id: "rec_bad",
      projectId: "prj_1",
      flowName: null,
      traceKey: "recordings/rec_bad/bundle.zip",
      origin: null,
      status: "uploaded",
    });
    await expect(
      compileRecording(
        {
          store,
          inference: {} as InferenceProvider,
          getObject: async () => Buffer.from("not a zip"),
          logger: pino({ level: "silent" }),
        },
        "rec_bad",
      ),
    ).rejects.toThrow();
    expect(store.recordings[0]!.status).toBe("failed");
  });
});

// ── Phase 11: payment detection (doc 03 B5) ────────────────────────────────
describe("payment detection → typed payment step", () => {
  function stripeHopTrace(): RecordingTrace {
    const base = buyRipTrace();
    // splice a hosted-checkout hop between the buy click and the success page:
    // nav to checkout.stripe.com, two clicks there, nav back to the app
    const stripeUrl = "https://checkout.stripe.com/c/pay/cs_test_a1b2c3";
    const mk = (id: string, ts: number, type: string, rest: Record<string, unknown> = {}) => ({
      id,
      ts,
      type,
      url: stripeUrl,
      target: null,
      value: null,
      screenshotBefore: null,
      screenshotAfter: null,
      domSnapshotAfter: null,
      network: [],
      ...rest,
    });
    const events = [...(base.events as Array<Record<string, unknown>>)];
    // replace e6/e7 (direct success navs) with the stripe hop then success
    const buyIdx = events.findIndex((e) => e.id === "e5");
    events.splice(
      buyIdx + 1,
      2,
      mk("p1", 2500, "navigation"),
      mk("p2", 3000, "click", {
        target: {
          tag: "button",
          locators: [
            { kind: "css", value: ".SubmitButton" },
            { kind: "text", value: "Pay" },
          ],
          a11y: { role: "button", name: "Pay", path: [] },
          boundingBox: { x: 0, y: 0, w: 10, h: 10 },
          isCanvas: false,
          canvasRelative: null,
        },
      }),
      { ...mk("p3", 4200, "navigation"), url: "https://demo.vercel.app/shop/success" },
    );
    return { ...base, events: events as RecordingTrace["events"] };
  }

  function assembleWith(hasPaymentConfig: boolean) {
    const trace = stripeHopTrace();
    const normalized = normalizeTrace(trace);
    const login = detectLogin(normalized.events);
    const paymentEventIds = new Set(
      normalized.events
        .filter((e) => /checkout\.stripe\.com/.test(e.event.url))
        .map((e) => e.event.id),
    );
    return assembleSpec({
      trace,
      events: normalized.events,
      login,
      suggestions: new Map<string, StepSuggestion>(),
      flowMeta: null,
      recordedFlowName: "Buy & Rip",
      projectId: "prj_1",
      flowId: "flw_1",
      knownTestIds: new Set(["buy-pack-btn", "pack-canvas"]),
      dropped: normalized.dropped,
      paymentEventIds,
      hasPaymentConfig,
    });
  }

  it("the provider click-sequence becomes exactly ONE typed payment step", () => {
    const { spec, report } = assembleWith(true);
    const paymentSteps = spec.steps.filter((s) => s.action.type === "payment");
    expect(paymentSteps).toHaveLength(1);
    expect(paymentSteps[0]!.action).toMatchObject({ provider: "stripe", variant: "card", configRef: "project" });
    // hallucination-guard bookkeeping: the typed step references the replaced event range
    expect(report.stepSourceEvents[paymentSteps[0]!.id]!.length).toBeGreaterThan(0);
    // no recorded stripe-internal click survives as its own step
    expect(spec.steps.some((s) => "locators" in s.action && JSON.stringify(s.action).includes("SubmitButton"))).toBe(false);
  });

  it("no payment config → the payment step is flagged needsAttention (consent gate)", () => {
    const { report } = assembleWith(false);
    expect(report.needsAttention.some((n) => n.message.includes("payment config"))).toBe(true);
    const { report: withConfig } = assembleWith(true);
    expect(withConfig.needsAttention.some((n) => n.message.includes("payment config"))).toBe(false);
  });
});
