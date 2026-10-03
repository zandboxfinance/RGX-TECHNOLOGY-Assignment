import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep iconv-lite's encoding tables out of the bundle; load them from node_modules at runtime.
  serverExternalPackages: ["iconv-lite"],
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
