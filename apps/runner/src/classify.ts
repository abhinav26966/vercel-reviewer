import { PNG } from "pngjs";
import type { Page } from "playwright";
import type { TraceNetworkEntry } from "@flowguard/schemas";

/**
 * The slow/hung/dead spectrum, failure-side classification (doc 04 §4).
 * Slow is decided by the orchestrator (needs base comparison); hung and dead
 * are classified here from live signals at the failing step.
 */

export interface ClassifyInput {
  settleTimedOut: boolean;
  pendingRequests: Array<{ method: string; url: string; pendingMs: number }>;
  stepNetwork: TraceNetworkEntry[];
  pageCrashed: boolean;
  pageErrors: number;
  nextErrorOverlay: boolean;
  blankScreenScore: number;
}

export interface Classification {
  status: "failed" | "hung" | "dead";
  failureClass: "assertion" | "hung_postcondition" | "crash" | "blank_screen";
  detail: string | null;
}

export function classifyFailure(input: ClassifyInput): Classification {
  // DEAD: crash / uncaught pageerror / Next.js error overlay / blank screen
  if (input.pageCrashed) {
    return { status: "dead", failureClass: "crash", detail: "page crashed" };
  }
  if (input.nextErrorOverlay) {
    return { status: "dead", failureClass: "crash", detail: "Next.js error overlay present" };
  }
  if (input.blankScreenScore > 0.98) {
    return {
      status: "dead",
      failureClass: "blank_screen",
      detail: `blank screen (uniformity ${(input.blankScreenScore * 100).toFixed(1)}%)`,
    };
  }
  if (input.pageErrors > 0) {
    return { status: "dead", failureClass: "crash", detail: `${input.pageErrors} uncaught page error(s)` };
  }

  // HUNG: post-condition never became true + a request stuck or a failed request
  // followed by a state that never resolved (doc 04 §4)
  if (input.settleTimedOut && input.pendingRequests.length > 0) {
    const p = input.pendingRequests[0]!;
    return {
      status: "hung",
      failureClass: "hung_postcondition",
      detail: `${p.method} ${pathOf(p.url)} pending ${(p.pendingMs / 1000).toFixed(0)}s`,
    };
  }
  const serverError = input.stepNetwork.find(
    (n) => n.status >= 500 && (n.resourceType === "fetch" || n.resourceType === "xhr"),
  );
  if (serverError) {
    return {
      status: "hung",
      failureClass: "hung_postcondition",
      detail: `${serverError.method} ${pathOf(serverError.url)} returned ${serverError.status}; expected state never appeared`,
    };
  }
  if (input.settleTimedOut) {
    return {
      status: "hung",
      failureClass: "hung_postcondition",
      detail: "post-conditions never became true within the settle window",
    };
  }

  return { status: "failed", failureClass: "assertion", detail: null };
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * Blank-screen score (doc 04 §4 "Dead"): fraction of sampled pixels within a
 * small delta of the dominant color. Near-1.0 ⇒ a blank/uniform page.
 */
export function blankScreenScore(pngBuffer: Buffer): number {
  let png: PNG;
  try {
    png = PNG.sync.read(pngBuffer);
  } catch {
    return 0;
  }
  const { width, height, data } = png;
  if (!width || !height) return 0;
  const stepX = Math.max(1, Math.floor(width / 64));
  const stepY = Math.max(1, Math.floor(height / 64));
  const buckets = new Map<number, number>();
  let total = 0;
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const i = (y * width + x) * 4;
      // quantize to 16-levels per channel so near-identical shades bucket together
      const key = ((data[i]! >> 4) << 8) | ((data[i + 1]! >> 4) << 4) | (data[i + 2]! >> 4);
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
      total++;
    }
  }
  const dominant = Math.max(...buckets.values());
  return total === 0 ? 0 : dominant / total;
}

/** Next.js error overlay / build error containers (doc 04 §4 — cheap, high-signal). */
export async function detectNextErrorOverlay(page: Page): Promise<boolean> {
  try {
    const count = await page
      .locator("nextjs-portal, #__next-build-error, #nextjs__container_errors_label")
      .count();
    if (count > 0) return true;
    // App Router production error page
    const text = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
    return /Application error: a client-side exception has occurred/i.test(text);
  } catch {
    return false;
  }
}
