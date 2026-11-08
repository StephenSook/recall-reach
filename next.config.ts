import type { NextConfig } from "next";

// Each way back from PayPal carries PayPal's ids in its address: a sandbox order's ids (the demo's and the shopping
// agent's, which repeats its order id on to /shopper/done), a connecting seller's merchant id, or an owner's sign-in code. They stay out of referrers, and out of Next's request log, which only the dev
// server writes. The host's own access log is outside this app; what limits it there is that the sign-in code works
// once and its state is used up on the first return.
const PAYPAL_RETURNS = ["/api/demo/buy/paypal/return", "/api/shop/paypal/back", "/api/owner/paypal/return", "/api/shopper/return", "/shopper/done"];

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: "/", headers: [{ key: "Link", value: '</.well-known/ai-catalog.json>; rel="ai-catalog"' }] },
      { source: "/r/:token", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
      { source: "/s/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "private, no-store" }] },
      { source: "/api/safety-receipts/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "private, no-store" }] },
      ...PAYPAL_RETURNS.map((source) => ({ source, headers: [{ key: "Referrer-Policy", value: "no-referrer" }] })),
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
  logging: { incomingRequests: { ignore: PAYPAL_RETURNS.map((path) => new RegExp(`${path}(\\?|$)`)) } },
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
