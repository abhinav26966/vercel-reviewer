import { describe, expect, it } from "vitest";
import { FlowSpecSchema, type FlowSpec } from "@flowguard/schemas";
import {
  apiRouteOfFile,
  globToRegExp,
  selectFlows,
  visitedSegments,
  type SelectableFlow,
} from "../src/orchestrator/select.js";

const ROOT = "examples/demo-app";

function makeSpec(startPath: string, navigateTo: string[] = []): FlowSpec {
  return FlowSpecSchema.parse({
    specVersion: 3,
    flowId: "flw_x",
    projectId: "prj_1",
    name: "X",
    startPath,
    steps: navigateTo.map((path, i) => ({
      id: `s${i + 1}`,
      title: `go to ${path}`,
      action: { type: "navigate", path },
      settle: { strategy: "networkidle", timeoutMs: 5000 },
      postConditions: [],
    })),
  });
}

function flow(over: Partial<SelectableFlow>): SelectableFlow {
  return {
    flowId: "flw_rip",
    flowName: "Buy & Rip",
    tier: "standard",
    spec: makeSpec("/shop", ["/open"]),
    coverage: {
      files: [
        `${ROOT}/src/components/PackScene.tsx`,
        `${ROOT}/src/components/OpenClient.tsx`,
        `${ROOT}/src/app/shop/page.tsx`,
        `${ROOT}/src/app/open/page.tsx`,
        `${ROOT}/src/app/inventory/page.tsx`,
      ],
      apiRoutes: ["/api/packs/buy", "/api/packs/open"],
    },
    ...over,
  };
}

const settings = { fanoutGlobs: [], authPathGlobs: [], rootDir: ROOT };

function run(changedFiles: string[], flows: SelectableFlow[], over: Partial<Parameters<typeof selectFlows>[0]> = {}) {
  return selectFlows({ changedFiles, diffTruncated: false, flows, settings, ...over });
}

describe("selectFlows — fan-out short-circuit (doc 06 §4.1)", () => {
  it.each([
    "pnpm-lock.yaml",
    "package.json",
    `${ROOT}/package.json`,
    `${ROOT}/next.config.ts`,
    `${ROOT}/tsconfig.json`,
    `${ROOT}/src/middleware.ts`,
    `${ROOT}/src/app/layout.tsx`,
    `${ROOT}/src/app/globals.css`,
    ".env.production",
    "vercel.json",
  ])("%s changes → everything runs", (file) => {
    const r = run([file, "README.md"], [flow({})]);
    expect(r.fanout).toContain(file);
    expect(r.selected).toHaveLength(1);
    expect(r.skipped).toHaveLength(0);
  });

  it("project fan-out globs and auth path globs fan out", () => {
    const r = run([`${ROOT}/src/lib/session.ts`], [flow({})], {
      settings: { ...settings, authPathGlobs: ["**/lib/session*"] },
    });
    expect(r.fanout).toContain("auth path");
  });

  it(">40% of covered files touched → coverage mapping invalidated", () => {
    const r = run(
      [
        `${ROOT}/src/components/PackScene.tsx`,
        `${ROOT}/src/app/shop/page.tsx`,
        `${ROOT}/src/app/open/page.tsx`,
      ],
      [flow({})],
    );
    expect(r.fanout).toContain(">40%");
  });

  it("truncated diff (300+ files) → everything runs", () => {
    const r = run(["README.md"], [flow({})], { diffTruncated: true });
    expect(r.fanout).toContain("too large");
  });
});

describe("selectFlows — tiers and cold start (doc 06 §4.2)", () => {
  it("smoke tier always runs, even on a README-only diff", () => {
    const r = run(["README.md"], [flow({ tier: "smoke", coverage: null })]);
    expect(r.selected[0]?.reason).toContain("smoke tier");
  });

  it("no coverage yet → always selected (cold start)", () => {
    const r = run(["README.md"], [flow({ coverage: null })]);
    expect(r.selected[0]?.reason).toContain("cold start");
  });
});

describe("selectFlows — intersection (doc 06 §4.3)", () => {
  it("coverage file matches a changed file", () => {
    const r = run([`${ROOT}/src/components/PackScene.tsx`, "docs/note.md"], [flow({})]);
    expect(r.selected[0]?.reason).toContain("touches examples/demo-app/src/components/PackScene.tsx");
  });

  it("changed API route handler matches a called route", () => {
    const r = run([`${ROOT}/src/app/api/packs/open/route.ts`], [flow({})]);
    expect(r.selected[0]?.reason).toContain("calls changed API route /api/packs/open");
  });

  it("route-directory heuristic: visited /open matches app/open/** changes", () => {
    const noOverlapCoverage = { files: ["src/never.ts"], apiRoutes: [] };
    const r = run([`${ROOT}/src/app/open/page.tsx`], [flow({ coverage: noOverlapCoverage })]);
    expect(r.selected[0]?.reason).toContain("visits /open");
  });

  it("no overlap → ⚪ skipped with the audit reason", () => {
    const r = run([`${ROOT}/README.md`], [flow({})]);
    expect(r.selected).toHaveLength(0);
    expect(r.skipped[0]?.reason).toBe("no overlap with the diff");
  });

  it("README-only PR runs only the smoke tier", () => {
    const r = run(
      ["README.md"],
      [flow({ flowId: "flw_login", flowName: "Login", tier: "smoke" }), flow({})],
    );
    expect(r.selected.map((s) => s.flowId)).toEqual(["flw_login"]);
    expect(r.skipped.map((s) => s.flowId)).toEqual(["flw_rip"]);
  });
});

describe("selection helpers", () => {
  it("apiRouteOfFile follows the Next.js convention", () => {
    expect(apiRouteOfFile("src/app/api/packs/buy/route.ts")).toBe("/api/packs/buy");
    expect(apiRouteOfFile("app/api/auth/route.js")).toBe("/api/auth");
    expect(apiRouteOfFile("src/app/shop/page.tsx")).toBeNull();
    expect(apiRouteOfFile("src/appx/api/y/route.ts")).toBeNull();
  });

  it("visitedSegments collects startPath + navigate segments, skipping /api", () => {
    expect(visitedSegments(makeSpec("/shop/success", ["/open", "/api/health"]))).toEqual(["shop", "open"]);
  });

  it("globToRegExp: ** spans segments including zero, * stays in-segment", () => {
    expect(globToRegExp("**/package.json").test("package.json")).toBe(true);
    expect(globToRegExp("**/package.json").test("a/b/package.json")).toBe(true);
    expect(globToRegExp("**/next.config.*").test("apps/web/next.config.mjs")).toBe(true);
    expect(globToRegExp("**/.env*").test(".env.local")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globToRegExp("**/tsconfig*.json").test("tsconfig.build.json")).toBe(true);
  });
});
