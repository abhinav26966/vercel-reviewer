import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: { ignoreDuringBuilds: true },
  // self-contained server bundle for the Docker image (Vercel ignores this)
  output: "standalone",
};

export default nextConfig;
