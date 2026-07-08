import type { Page, Request } from "playwright";
import type { TraceNetworkEntry } from "@flowguard/schemas";

interface PendingInfo {
  method: string;
  url: string;
  startedAt: number;
}

/**
 * Tracks requests for two purposes (doc 02 §5, doc 04 §4):
 * - per-step network windows (requests started between step start and settle end)
 * - requests still pending at a settle timeout (hang diagnosis)
 */
export class NetworkTracker {
  private pending = new Map<Request, PendingInfo>();
  private finished: Array<TraceNetworkEntry & { startedAt: number }> = [];

  attach(page: Page): void {
    page.on("request", (req) => {
      this.pending.set(req, { method: req.method(), url: req.url(), startedAt: Date.now() });
    });
    const complete = (req: Request, status: number) => {
      const info = this.pending.get(req);
      if (!info) return;
      this.pending.delete(req);
      const timing = req.timing();
      const ttfb = timing.responseStart > 0 ? timing.responseStart - Math.max(timing.requestStart, 0) : 0;
      this.finished.push({
        method: info.method,
        url: info.url,
        status,
        ttfbMs: Math.max(0, Math.round(ttfb)),
        totalMs: Math.max(0, Date.now() - info.startedAt),
        resourceType: req.resourceType(),
        startedAt: info.startedAt,
      });
    };
    page.on("requestfinished", (req) => {
      void req.response().then((res) => complete(req, res?.status() ?? 0));
    });
    page.on("requestfailed", (req) => complete(req, 0));
  }

  /** Finished requests whose start fell inside [fromMs, toMs]. */
  window(fromMs: number, toMs: number): TraceNetworkEntry[] {
    return this.finished
      .filter((e) => e.startedAt >= fromMs && e.startedAt <= toMs)
      .map(({ startedAt: _startedAt, ...entry }) => entry);
  }

  pendingRequests(): Array<{ method: string; url: string; pendingMs: number }> {
    const now = Date.now();
    return [...this.pending.values()].map((p) => ({
      method: p.method,
      url: p.url,
      pendingMs: now - p.startedAt,
    }));
  }
}
