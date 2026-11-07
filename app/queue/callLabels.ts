// How a logged PayPal call reads: what carried it, and PayPal's own page for that API.
const DOCS = "https://developer.paypal.com/docs/api";

export function callThrough(call: { method: string; template: string }): string {
  if (call.method === "POST" && /^\/v2\/payments\/captures\/:id\/refund$/.test(call.template)) return "Agent Toolkit";
  if (call.method === "GET" && /^\/v2\/payments\/refunds\/:id$/.test(call.template)) return "Server SDK";
  return "REST";
}

export function callDocs(template: string): string | null {
  if (template.startsWith("/v2/checkout/orders")) return `${DOCS}/orders/v2/`;
  if (template.startsWith("/v2/payments/")) return `${DOCS}/payments/v2/`;
  if (template.startsWith("/v1/reporting/transactions")) return `${DOCS}/transaction-search/v1/`;
  if (template.startsWith("/v1/customer/disputes")) return `${DOCS}/customer-disputes/v1/`;
  return null;
}
