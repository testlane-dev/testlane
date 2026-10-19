import path from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The smoke test builds into its own folder so it can run next to a live `npm run demo`.
  distDir: process.env.DEMO_NEXT_DIST_DIR || ".next",
  // The demo lives inside the broker repo (which has its own lockfile); pin the
  // workspace root to this folder so Next does not guess.
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
};

export default nextConfig;
