import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Stop `next dev` from rewriting the checked-in AGENTS.md.
  agentRules: false,
};

export default nextConfig;
