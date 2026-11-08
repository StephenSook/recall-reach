import type { NextConfig } from "next";

// PayPal adds its order and payer ids to this address, and those stay out of logs and referrers.
const PAYPAL_RETURN = "/api/demo/buy/paypal/return";

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: "/", headers: [{ key: "Link", value: '</.well-known/ai-catalog.json>; rel="ai-catalog"' }] },
      { source: "/r/:token", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
      { source: "/s/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "private, no-store" }] },
      { source: "/api/safety-receipts/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "private, no-store" }] },
      { source: PAYPAL_RETURN, headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
    ];
  },
  // The API docs portal APIMatic generated is static files in public/api-docs. A folder's address serves its index.html.
  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [
        { source: "/api-docs", destination: "/api-docs/index.html" },
        { source: "/api-docs/:path*", destination: "/api-docs/:path*/index.html" },
      ],
      fallback: [],
    };
  },
  logging: { incomingRequests: { ignore: [new RegExp(PAYPAL_RETURN)] } },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
