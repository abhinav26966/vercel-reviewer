import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: {
    // linted by the monorepo root eslint config instead
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
