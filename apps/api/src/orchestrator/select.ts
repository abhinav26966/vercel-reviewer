import type { FlowSpec } from "@flowguard/schemas";

/**
 * Diff-aware flow selection (doc 06 §4): fan-out short-circuit → smoke tier →
 * cold start → intersection (coverage files / API routes / route-directory
 * heuristic) → everything else ⚪ skipped with an auditable reason.
 *
 * A false negative ("we skipped the flow that broke") is worse than wasted
 * compute — every ambiguity resolves toward selecting.
 */

export interface SelectableFlow {
  flowId: string;
  flowName: string;
  tier: string;
  spec: FlowSpec;
  /** Latest coverage_maps row for (flow, base branch); repo-relative files. */
  coverage: { files: string[]; apiRoutes: string[] } | null;
}

export interface SelectionSettings {
  fanoutGlobs: string[];
  authPathGlobs: string[];
  /** Vercel Root Directory within the repo ("" = repo root). */
  rootDir: string;
}

export interface FlowSelectionReason {
  flowId: string;
  flowName: string;
  reason: string;
}

export interface SelectionResult {
  selected: FlowSelectionReason[];
  skipped: FlowSelectionReason[];
  /** Non-null ⇒ the fan-out short-circuit fired (everything runs). */
  fanout: string | null;
}

/** Built-in fan-out triggers (doc 06 §4.1). */
const FANOUT_GLOBS = [
  "**/package.json",
  "**/pnpm-lock.yaml",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/next.config.*",
  "**/tsconfig*.json",
  "**/.env*",
  "**/vercel.json",
  "**/middleware.*",
  "**/tailwind.config.*",
  "**/globals.css",
  "**/global.css",
  "**/app/layout.*",
];

export function selectFlows(params: {
  changedFiles: string[];
  /** GitHub compare caps the file list at 300 — a truncated diff fans out. */
  diffTruncated: boolean;
  flows: SelectableFlow[];
  settings: SelectionSettings;
}): SelectionResult {
  const { changedFiles, flows, settings } = params;
  const selected: FlowSelectionReason[] = [];
  const skipped: FlowSelectionReason[] = [];

  const fanout = fanoutReason(params);
  for (const f of flows) {
    const reason = fanout ?? flowReason(f, changedFiles, settings.rootDir);
    if (reason) selected.push({ flowId: f.flowId, flowName: f.flowName, reason });
    else skipped.push({ flowId: f.flowId, flowName: f.flowName, reason: "no overlap with the diff" });
  }
  return { selected, skipped, fanout };
}

function fanoutReason(params: {
  changedFiles: string[];
  diffTruncated: boolean;
  flows: SelectableFlow[];
  settings: SelectionSettings;
}): string | null {
  const { changedFiles, flows, settings } = params;
  if (params.diffTruncated) return "diff too large to enumerate (300+ files)";

  for (const [globs, label] of [
    [FANOUT_GLOBS, "shared config"],
    [settings.fanoutGlobs, "project fan-out glob"],
    [settings.authPathGlobs, "auth path"],
  ] as const) {
    for (const glob of globs) {
      const re = globToRegExp(glob);
      const hit = changedFiles.find((f) => re.test(f));
      if (hit) return `${label} changed: ${hit}`;
    }
  }

  // >40% of files with coverage mappings touched ⇒ the mapping is invalidated
  const mapped = new Set(flows.flatMap((f) => f.coverage?.files ?? []));
  if (mapped.size > 0) {
    const touched = changedFiles.filter((f) => mapped.has(f)).length;
    if (touched / mapped.size > 0.4) {
      return `${touched}/${mapped.size} covered files touched (>40% — coverage mapping invalidated)`;
    }
  }
  return null;
}

function flowReason(f: SelectableFlow, changedFiles: string[], rootDir: string): string | null {
  if (f.tier === "smoke") return "smoke tier — always runs";
  if (!f.coverage) return "no coverage collected yet (cold start)";

  const fileHits = f.coverage.files.filter((cf) => changedFiles.includes(cf));
  if (fileHits.length > 0) {
    const more = fileHits.length > 1 ? ` (+${fileHits.length - 1} more)` : "";
    return `touches ${fileHits[0]}${more}`;
  }

  const changedRoutes = new Set(changedFiles.map((cf) => apiRouteOfFile(stripRoot(cf, rootDir))).filter(Boolean));
  const routeHit = f.coverage.apiRoutes.find((r) => changedRoutes.has(r));
  if (routeHit) return `calls changed API route ${routeHit}`;

  // route-directory heuristic (doc 06 §4.3): a visited page's app/<segment>/**
  const segments = visitedSegments(f.spec);
  for (const cf of changedFiles) {
    const rel = stripRoot(cf, rootDir);
    for (const seg of segments) {
      if (new RegExp(`(^|/)app/${escapeRe(seg)}(/|\\.|$)`).test(rel)) {
        return `visits /${seg} — changed under app/${seg}`;
      }
    }
  }
  return null;
}

/** `<root>/src/app/api/packs/buy/route.ts` → `/api/packs/buy` (Next.js convention). */
export function apiRouteOfFile(relPath: string): string | null {
  const m = relPath.match(/(?:^|\/)app\/(api\/.+)\/route\.(?:ts|tsx|js|jsx|mjs)$/);
  return m ? `/${m[1]}` : null;
}

/** First path segments the flow's spec visits (startPath + navigate steps). */
export function visitedSegments(spec: FlowSpec): string[] {
  const paths = [spec.startPath];
  for (const step of spec.steps) {
    if (step.action.type === "navigate" && step.action.path) paths.push(step.action.path);
  }
  const segments = new Set<string>();
  for (const p of paths) {
    const seg = p.replace(/^https?:\/\/[^/]+/, "").split("/").filter(Boolean)[0];
    if (seg && seg !== "api") segments.add(seg);
  }
  return [...segments];
}

function stripRoot(path: string, rootDir: string): string {
  if (rootDir && path.startsWith(rootDir + "/")) return path.slice(rootDir.length + 1);
  return path;
}

/** Minimal glob → RegExp: `**` any depth, `*` within a segment, `?` one char. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more whole segments; bare `**` matches anything
        re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += glob[i + 2] === "/" ? 3 : 2;
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += escapeRe(c);
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
