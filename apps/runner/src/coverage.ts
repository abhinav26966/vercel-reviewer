import type { Page } from "playwright";
import type { Logger } from "pino";
import type { FlowCoverage, TraceNetworkEntry } from "@flowguard/schemas";

/**
 * Coverage collection (doc 04 §7): CDP precise coverage over the whole flow →
 * executed first-party chunks → source-map resolution → app-relative file set.
 * Attribution is CHUNK-LEVEL: any executed function attributes all of the
 * chunk's sources. Over-approximating selects a few extra flows; a false
 * negative skips the flow that broke — always err wide.
 */

export async function startCoverage(page: Page, logger: Logger): Promise<boolean> {
  try {
    await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false });
    return true;
  } catch (err) {
    logger.warn({ err }, "JS coverage unavailable — selection will use route heuristics");
    return false;
  }
}

export async function collectCoverage(
  page: Page,
  networkEntries: TraceNetworkEntry[],
  deploymentUrl: string,
  logger: Logger,
  bypassSecret?: string | null,
): Promise<FlowCoverage> {
  const origin = new URL(deploymentUrl).origin;
  const files = new Set<string>();
  let mapsTried = 0;
  let mapsResolved = 0;

  let entries: Awaited<ReturnType<Page["coverage"]["stopJSCoverage"]>> = [];
  try {
    entries = await page.coverage.stopJSCoverage();
  } catch (err) {
    logger.warn({ err }, "stopJSCoverage failed");
  }

  for (const entry of entries) {
    if (!entry.url.startsWith(origin)) continue;
    const executed = entry.functions.some((f) => f.ranges.some((r) => r.count > 0));
    if (!executed) continue;
    const mapUrl = sourceMapUrl(entry.url, entry.source ?? "");
    if (!mapUrl) continue;
    mapsTried++;
    try {
      // the bypass COOKIE doesn't reach APIRequestContext fetches on protected
      // deployments (observed 403) — send the bypass header explicitly
      const res = await page.request.get(mapUrl, {
        timeout: 10_000,
        headers: bypassSecret ? { "x-vercel-protection-bypass": bypassSecret } : {},
      });
      if (!res.ok()) continue;
      const map = (await res.json()) as { sources?: string[] };
      for (const src of map.sources ?? []) {
        const normalized = normalizeSourcePath(src);
        if (normalized) files.add(normalized);
      }
      mapsResolved++;
    } catch {
      // absent source maps are expected on many deployments (doc 04 §7 fallback)
    }
  }
  logger.info({ mapsTried, mapsResolved, files: files.size }, "coverage collected");

  return {
    files: [...files].sort(),
    apiRoutes: apiRoutesFrom(networkEntries, origin),
    sourceMapsResolved: mapsResolved > 0,
  };
}

/** `<chunk>.js.map` next to the chunk, or the script's sourceMappingURL comment. */
function sourceMapUrl(scriptUrl: string, source: string): string | null {
  const tail = source.slice(-1024);
  const m = tail.match(/\/\/# sourceMappingURL=([^\s]+)\s*$/);
  if (m && !m[1]!.startsWith("data:")) {
    try {
      return new URL(m[1]!, scriptUrl).toString();
    } catch {
      return null;
    }
  }
  return scriptUrl.split("?")[0] + ".map";
}

/**
 * webpack source paths → app-root-relative repo paths:
 *   webpack://_N_E/./src/components/PackScene.tsx → src/components/PackScene.tsx
 * Drops node_modules, webpack runtime/virtual modules, and absolute/external URLs.
 */
export function normalizeSourcePath(source: string): string | null {
  let s = source.replace(/^webpack:\/\/[^/]*\//, "");
  while (s.startsWith("./")) s = s.slice(2);
  if (!s || s.startsWith("(") || s.startsWith("ignored|")) return null;
  if (/(^|\/)node_modules\//.test(s)) return null;
  if (s.startsWith("webpack/") || s.startsWith("external ")) return null;
  if (/^[a-z]+:\/\//i.test(s) || s.startsWith("/")) return null;
  // "../../../../src/client/…" = framework sources outside the app root
  if (s.startsWith("../")) return null;
  if (s.includes("?")) s = s.split("?")[0]!;
  return s;
}

/** First-party /api/* request paths seen during the flow (deduped URL paths). */
export function apiRoutesFrom(entries: TraceNetworkEntry[], origin: string): string[] {
  const routes = new Set<string>();
  for (const e of entries) {
    if (!["fetch", "xhr", "document"].includes(e.resourceType)) continue;
    try {
      const u = new URL(e.url);
      if (u.origin !== origin) continue;
      if (u.pathname.startsWith("/api/")) routes.add(u.pathname);
    } catch {
      continue;
    }
  }
  return [...routes].sort();
}
