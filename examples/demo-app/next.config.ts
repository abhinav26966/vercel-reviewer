import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: {
    // linted by the monorepo root eslint config instead
    ignoreDuringBuilds: true,
  },
  // FlowGuard resolves executed chunks to source files for diff-aware flow
  // selection (doc 04 §7) — without maps it falls back to route heuristics
  productionBrowserSourceMaps: true,
};

export default nextConfig;
