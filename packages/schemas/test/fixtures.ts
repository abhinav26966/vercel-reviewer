import type { z } from "zod";
import type {
  ExecuteFlowJobSchema,
  FlowSpecSchema,
  RecordingTraceSchema,
  RunFlowResultSchema,
  VerdictSchema,
} from "../src/index.js";

/** Doc 02 §1 example, near-verbatim. */
export const validRecordingTrace: z.input<typeof RecordingTraceSchema> = {
  traceVersion: 1,
  recordedAt: "2026-07-05T10:00:00Z",
  origin: "https://staging.packgame.com",
  viewport: { width: 1280, height: 720, dpr: 1 },
  userAgent: "Mozilla/5.0 (Macintosh) Chrome/126.0",
  events: [
    {
      id: "evt_0001",
      ts: 1520,
      type: "click",
      url: "https://staging.packgame.com/shop",
      target: {
        tag: "button",
        locators: [
          { kind: "testid", value: "buy-pack-btn" },
          { kind: "role", value: { role: "button", name: "Buy Pack" } },
          { kind: "text", value: "Buy Pack" },
          { kind: "css", value: "#shop > div.grid > button:nth-child(2)" },
        ],
        a11y: {
          role: "button",
          name: "Buy Pack",
          path: ["main", "region[name=Shop]", "button[name=Buy Pack]"],
        },
        boundingBox: { x: 412, y: 300, w: 120, h: 44 },
        isCanvas: false,
        canvasRelative: null,
      },
      value: null,
      screenshotBefore: "shots/evt_0001_before.png",
      screenshotAfter: "shots/evt_0001_after.png",
      domSnapshotAfter: "dom/evt_0001.json",
      network: [
        {
          method: "POST",
          url: "/api/packs/buy",
          status: 200,
          ttfbMs: 84,
          totalMs: 130,
          resourceType: "fetch",
        },
      ],
    },
    {
      id: "evt_0002",
      ts: 3200,
      type: "input",
      url: "https://staging.packgame.com/login",
      target: {
        tag: "input",
        locators: [
          { kind: "testid", value: "password-input" },
          { kind: "css", value: "input[type=password]" },
        ],
        a11y: null,
        boundingBox: { x: 100, y: 220, w: 240, h: 36 },
        isCanvas: false,
        canvasRelative: null,
      },
      value: "«redacted:password»",
      screenshotBefore: null,
      screenshotAfter: null,
      domSnapshotAfter: null,
      network: [],
    },
  ],
  finalScreenshot: "shots/final.png",
  consoleErrors: [{ ts: 4100, text: "hydration warning" }],
};

/** Doc 02 §2 example, near-verbatim (the "Buy & Rip Open a Pack" spec). */
export const validFlowSpec: z.input<typeof FlowSpecSchema> = {
  specVersion: 3,
  flowId: "flw_9f2c",
  projectId: "prj_a1",
  name: "Buy & Rip Open a Pack",
  description:
    "From shop, purchase a pack with Stripe test card, then open it and verify 5 cards revealed.",
  tier: "standard",
  persona: "premium_user",
  startPath: "/shop",
  viewport: { width: 1280, height: 720, dpr: 1 },
  env: { requiresWebGL: true },
  budgets: {
    flowTotalMs: { soft: 15000, hard: null },
    perStepDefaults: { relativeFactor: 3.0, absoluteFloorMs: 500 },
  },
  steps: [
    {
      id: "s1",
      title: "Click Buy Pack",
      intent: "Purchase one pack from the shop grid",
      action: {
        type: "click",
        locators: [
          { kind: "testid", value: "buy-pack-btn" },
          { kind: "role", value: { role: "button", name: "Buy Pack" } },
          { kind: "text", value: "Buy Pack" },
        ],
      },
      settle: { strategy: "networkidle+animation", timeoutMs: 10000 },
      postConditions: [
        {
          kind: "dom",
          assert: "visible",
          locators: [{ kind: "testid", value: "stripe-checkout" }],
          description: "Stripe checkout appears",
        },
      ],
      timingBaselineKey: "s1",
    },
    {
      id: "s2",
      title: "Pay with test card",
      action: { type: "payment", provider: "stripe", variant: "card", configRef: "project" },
      settle: { strategy: "navigation", timeoutMs: 20000 },
      postConditions: [
        { kind: "url", assert: "pathMatches", value: "/shop/success" },
        {
          kind: "dom",
          assert: "visible",
          locators: [{ kind: "text", value: "Purchase complete" }],
        },
      ],
      caveats: ["webhook_dependent"],
    },
    {
      id: "s3",
      title: "Open inventory and verify pack count increased",
      action: { type: "navigate", path: "/inventory" },
      settle: { strategy: "networkidle", timeoutMs: 8000 },
      postConditions: [
        {
          kind: "delta",
          metric: "packCount",
          read: { kind: "dom-count", locators: [{ kind: "testid", value: "pack-card" }] },
          assert: "increasedBy",
          value: 1,
          description:
            "Pack count is +1 vs start of flow (delta assertion — shared test account accumulates state)",
        },
      ],
    },
    {
      id: "s4",
      title: "Rip open the pack",
      action: {
        type: "canvasClick",
        canvasLocator: [
          { kind: "testid", value: "pack-canvas" },
          { kind: "css", value: "canvas" },
        ],
        point: { nx: 0.5, ny: 0.62 },
        visionFallback: { describe: "the unopened glowing card pack in the center of the 3D scene" },
      },
      settle: {
        strategy: "animationQuiescence",
        timeoutMs: 15000,
        quiescence: { sampleEveryMs: 500, stableFrames: 3, diffThresholdPct: 1.5 },
      },
      postConditions: [
        {
          kind: "state",
          read: "window.__flowState.cardsRevealed",
          assert: "equals",
          value: 5,
          optional: true,
          description: "Preferred: state SDK if the app exposes it",
        },
        {
          kind: "vision",
          question:
            "How many trading cards are face-up and fully revealed on screen? Answer with an integer.",
          assert: "equals",
          value: 5,
          description: "Fallback: semantic visual assertion at settle point",
        },
      ],
    },
  ],
  coverage: {
    files: ["app/shop/page.tsx", "components/PackCanvas.tsx", "app/api/packs/buy/route.ts"],
    apiRoutes: ["POST /api/packs/buy", "GET /api/inventory"],
    collectedAtSha: "abc123",
    collectedAt: "2026-07-05T10:20:00Z",
  },
};

/** Doc 02 §5 example, expanded to full shape. */
export const validRunFlowResult: z.input<typeof RunFlowResultSchema> = {
  runId: "run_x",
  flowId: "flw_9f2c",
  specVersionId: "fsv_12",
  target: "head",
  status: "failed",
  failedStepId: "s4",
  failureClass: "assertion",
  healAttempt: { attempted: true, succeeded: false, proposedPatch: null },
  steps: [
    {
      id: "s1",
      durationMs: 640,
      settleMs: 210,
      network: [
        {
          method: "POST",
          url: "/api/packs/buy",
          status: 200,
          ttfbMs: 84,
          totalMs: 130,
          resourceType: "fetch",
        },
      ],
      screenshot: "shots/s1.png",
      assertions: [{ kind: "dom", pass: true }],
    },
  ],
  perf: {
    flowTotalMs: 9400,
    regressions: [
      {
        stepId: "s2",
        baseMs: 210,
        headMs: 1900,
        attribution: {
          kind: "network",
          request: "POST /api/packs/buy",
          baseTtfb: 84,
          headTtfb: 1720,
        },
      },
    ],
  },
  artifacts: {
    video: "s3://artifacts/run_x/video.webm",
    trace: "s3://artifacts/run_x/trace.zip",
    har: "s3://artifacts/run_x/net.har",
    console: "s3://artifacts/run_x/console.log",
    coverage: "s3://artifacts/run_x/coverage.json",
  },
  diagnostics: {
    pendingRequestsAtTimeout: [{ method: "POST", url: "/api/packs/open", pendingMs: 30000 }],
    consoleErrors: [],
    pageCrashed: false,
    nextErrorOverlay: false,
    blankScreenScore: 0.02,
  },
};

/** Doc 04 §1 example (+ inline spec; cvc as secret ref per doc 07 §4). */
export const validExecuteFlowJob: z.input<typeof ExecuteFlowJobSchema> = {
  runId: "run_x",
  flowId: "flw_9f2c",
  specVersionId: "fsv_12",
  spec: validFlowSpec,
  target: {
    kind: "head",
    deploymentUrl: "https://app-git-feat-x.vercel.app",
    bypassSecret: "bypass-secret-value",
    sha: "def456",
  },
  configBundle: {
    persona: {
      name: "premium_user",
      usernameRef: "sec_1",
      passwordRef: "sec_2",
      storageStateKey: "ss/prj_a1/premium_user/dep_123.json",
    },
    payment: {
      provider: "stripe",
      cardRef: "sec_9",
      expiry: "12/34",
      cvcRef: "sec_10",
      source: "project",
    },
    dataBranchDiffers: true,
  },
  mode: "measure",
  collect: { coverage: true, har: true, video: true },
  abortToken: "abort_tok_1",
};

export const validVerdict: z.input<typeof VerdictSchema> = {
  runId: "run_x",
  flowId: "flw_9f2c",
  verdict: "broken",
  confidence: 0.92,
  rationale: "Post-condition failed on head while base passed the same step.",
  humanCopy:
    'stuck at step 4 "Rip open the pack": clicked pack, no cards revealed after 15s; POST /api/packs/open → 500',
  evidence: { video: "s3://artifacts/run_x/video.webm" },
  approvalState: null,
};
