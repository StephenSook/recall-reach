import type { NextConfig } from "next";

// PayPal adds its order and payer ids to this address, and those stay out of logs and referrers.
const PAYPAL_RETURN = "/api/demo/buy/paypal/return";

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: "/", headers: [{ key: "Link", value: '</.well-known/ai-catalog.json>; rel="ai-catalog"' }] },
      { source: "/r/:token", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
      { source: PAYPAL_RETURN, headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
    ];
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
