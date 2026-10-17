// RELAY_STATIC_EXPORT=1 builds Mission Control as static files (mission-control/out)
// that `relay serve` hosts on the API port — that is what the npm package ships.
// In dev, /api/* is proxied to the relay backend instead.
const staticExport = process.env.RELAY_STATIC_EXPORT === "1";

/** @type {import('next').NextConfig} */
const nextConfig = staticExport
  ? { output: "export", images: { unoptimized: true } }
  : {
      async rewrites() {
        return [{ source: "/api/:path*", destination: "http://127.0.0.1:3001/api/:path*" }];
      },
    };

module.exports = nextConfig;
