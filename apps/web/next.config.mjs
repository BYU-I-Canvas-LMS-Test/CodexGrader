// Next.js config — plain ESM (.mjs), NOT TypeScript: a .ts config needs the
// native SWC compiler at runtime, and the shipped bundle carries no native
// binaries (it must run on any platform's Node 24).
//
// The app is served by the local server's custom server (apps/aigrader), so
// there is no `output: 'standalone'` build — `next start` is never used.

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The review UI never optimizes images (the course picker shows Canvas
  // course images as plain <img> tags).
  images: { unoptimized: true },
  poweredByHeader: false,
};

export default nextConfig;
