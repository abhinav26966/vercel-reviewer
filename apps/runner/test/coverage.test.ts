import { describe, expect, it } from "vitest";
import { apiRoutesFrom, normalizeSourcePath } from "../src/coverage.js";
import type { TraceNetworkEntry } from "@flowguard/schemas";

describe("normalizeSourcePath", () => {
  it("strips webpack prefixes to app-relative paths", () => {
    expect(normalizeSourcePath("webpack://_N_E/./src/components/PackScene.tsx")).toBe(
      "src/components/PackScene.tsx",
    );
    expect(normalizeSourcePath("webpack://demo/./app/shop/page.tsx")).toBe("app/shop/page.tsx");
  });

  it("drops node_modules, webpack runtime, externals, and absolute urls", () => {
    expect(normalizeSourcePath("webpack://_N_E/./node_modules/react/index.js")).toBeNull();
    expect(normalizeSourcePath("webpack://_N_E/webpack/bootstrap")).toBeNull();
    expect(normalizeSourcePath("webpack://_N_E/(webpack)/buildin/global.js")).toBeNull();
    expect(normalizeSourcePath("webpack://_N_E/external commonjs \"next\"")).toBeNull();
    expect(normalizeSourcePath("https://cdn.example.com/lib.js")).toBeNull();
    expect(normalizeSourcePath("/absolute/path.ts")).toBeNull();
  });

  it("strips query strings from virtual loaders", () => {
    expect(normalizeSourcePath("webpack://_N_E/./src/app/page.tsx?abc123")).toBe("src/app/page.tsx");
  });
});

describe("apiRoutesFrom", () => {
  const entry = (url: string, resourceType = "fetch"): TraceNetworkEntry => ({
    method: "POST",
    url,
    status: 200,
    ttfbMs: 10,
    totalMs: 20,
    resourceType,
  });

  it("keeps first-party /api/* paths, deduped and sorted", () => {
    const routes = apiRoutesFrom(
      [
        entry("https://preview.vercel.app/api/packs/buy"),
        entry("https://preview.vercel.app/api/packs/buy"),
        entry("https://preview.vercel.app/api/packs/open?break=rip", "document"),
        entry("https://preview.vercel.app/shop", "document"),
        entry("https://third-party.com/api/track"),
        entry("https://preview.vercel.app/api/img.png", "image"),
      ],
      "https://preview.vercel.app",
    );
    expect(routes).toEqual(["/api/packs/buy", "/api/packs/open"]);
  });
});
