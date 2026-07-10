import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { blankScreenScore, classifyFailure } from "../src/classify.js";

const base = {
  settleTimedOut: false,
  pendingRequests: [] as Array<{ method: string; url: string; pendingMs: number }>,
  stepNetwork: [] as never[],
  pageCrashed: false,
  pageErrors: 0,
  nextErrorOverlay: false,
  blankScreenScore: 0,
  mainContentCount: 0,
};

describe("classifyFailure (doc 04 §4)", () => {
  it("plain assertion failure stays failed/assertion", () => {
    expect(classifyFailure({ ...base })).toEqual({ status: "failed", failureClass: "assertion", detail: null });
  });

  it("settle timeout + pending request → hung, naming the request", () => {
    const c = classifyFailure({
      ...base,
      settleTimedOut: true,
      pendingRequests: [{ method: "POST", url: "https://x/api/packs/open", pendingMs: 30000 }],
    });
    expect(c.status).toBe("hung");
    expect(c.failureClass).toBe("hung_postcondition");
    expect(c.detail).toBe("POST /api/packs/open pending 30s");
  });

  it("5xx fetch + failed post-condition → hung, naming the 500", () => {
    const c = classifyFailure({
      ...base,
      stepNetwork: [
        { method: "POST", url: "https://x/api/packs/open", status: 500, ttfbMs: 60, totalMs: 80, resourceType: "fetch" },
      ] as never,
    });
    expect(c.status).toBe("hung");
    expect(c.detail).toContain("POST /api/packs/open returned 500");
  });

  it("crash / overlay / blank / pageerror → dead (in priority order)", () => {
    expect(classifyFailure({ ...base, pageCrashed: true }).status).toBe("dead");
    expect(classifyFailure({ ...base, nextErrorOverlay: true }).detail).toContain("error overlay");
    const blank = classifyFailure({ ...base, blankScreenScore: 0.995 });
    expect(blank.status).toBe("dead");
    expect(blank.failureClass).toBe("blank_screen");
    expect(classifyFailure({ ...base, pageErrors: 2 }).failureClass).toBe("crash");
  });

  it("blank pixels but rendered content (dark/empty-state page) is NOT dead", () => {
    const c = classifyFailure({ ...base, blankScreenScore: 0.992, mainContentCount: 3 });
    expect(c.status).not.toBe("dead");
    expect(c.failureClass).toBe("assertion");
  });

  it("dead outranks hung when both signal", () => {
    const c = classifyFailure({
      ...base,
      blankScreenScore: 0.99,
      settleTimedOut: true,
      pendingRequests: [{ method: "GET", url: "https://x/a", pendingMs: 1000 }],
    });
    expect(c.status).toBe("dead");
  });
});

describe("blankScreenScore", () => {
  function png(width: number, height: number, paint: (x: number, y: number) => [number, number, number]) {
    const img = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const [r, g, b] = paint(x, y);
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    return PNG.sync.write(img);
  }

  it("uniform page scores ~1.0, busy page scores low", () => {
    const blank = png(200, 150, () => [13, 17, 23]);
    expect(blankScreenScore(blank)).toBeGreaterThan(0.98);
    const busy = png(200, 150, (x, y) => [(x * 37) % 256, (y * 91) % 256, (x + y) % 256]);
    expect(blankScreenScore(busy)).toBeLessThan(0.5);
    expect(blankScreenScore(Buffer.from("not a png"))).toBe(0);
  });

  it("page with a small header on a uniform body still reads as blank-ish", () => {
    const mostlyBlank = png(200, 150, (_x, y) => (y < 8 ? [200, 200, 200] : [13, 17, 23]));
    expect(blankScreenScore(mostlyBlank)).toBeGreaterThan(0.9);
  });
});
