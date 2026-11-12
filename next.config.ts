import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  devIndicators: false,
  output: "standalone",
  // The Kubernetes client is a Node CJS package with dynamic requires; keep it
  // out of the bundler so standalone output imports it at runtime.
  serverExternalPackages: ["@kubernetes/client-node"],
}

export default nextConfig
