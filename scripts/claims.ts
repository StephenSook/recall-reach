// Every technology we say we use, and the code that has to be there for it to be true. This list is the Devpost Built With
// list and the form's checkboxes: nothing outside "claimed" gets ticked, and pnpm claims fails CI if a claimed row loses its
// call, or a cut one is mentioned on a page anyone can read.
export interface Evidence {
  file: string;
  /** A pattern that must match the file's code, with comments taken out. */
  find: string;
}

export type Claim =
  | { name: string; status: "claimed"; evidence: Evidence[] }
  | { name: string; status: "cut"; why: string; mentions: string[] };

export const CLAIMS: Claim[] = [
  {
    name: "PayPal Transaction Search",
    status: "claimed",
    evidence: [
      { file: "server/paypal/transactions.ts", find: "export async function searchTransactions" },
      { file: "server/demo/seed.ts", find: "searchTransactions\\(" },
    ],
  },
  {
    name: "PayPal Orders v2",
    status: "claimed",
    evidence: [
      { file: "server/paypal/orders.ts", find: "/v2/checkout/orders" },
      { file: "server/demo/seed.ts", find: "createCardOrder\\(" },
      { file: "server/demo/liveCatch.ts", find: "getOrder\\(" },
    ],
  },
  {
    name: "PayPal Payments refunds",
    status: "claimed",
    evidence: [
      { file: "server/paypal/refunds.ts", find: "/v2/payments/refunds/" },
      { file: "app/api/queue/refunds/execute/route.ts", find: "executeRefund\\(" },
    ],
  },
  {
    name: "PayPal webhooks",
    status: "claimed",
    evidence: [
      { file: "server/paypal/webhookHandler.ts", find: "verifyWebhook\\(" },
      { file: "app/api/paypal/webhook/route.ts", find: "handleWebhookDelivery\\(" },
    ],
  },
  {
    name: "PayPal Agent Toolkit",
    status: "claimed",
    evidence: [
      { file: "server/paypal/toolkitRefund.ts", find: "export function refundsThroughToolkit" },
      { file: "server/paypal/client.ts", find: "refundsThroughToolkit\\(\\)" },
    ],
  },
  {
    name: "Claude",
    status: "claimed",
    evidence: [
      { file: "server/agent/claude.ts", find: "@anthropic-ai/sdk" },
      { file: "server/agent/recallAgent.ts", find: "askClaude\\(" },
      { file: "server/agent/recallQuestion.ts", find: "askClaude\\(" },
    ],
  },
  {
    name: "CPSC Recalls API",
    status: "claimed",
    evidence: [
      { file: "server/cpsc/fetch.ts", find: "saferproducts\\.gov" },
      { file: "server/cpsc/pull.ts", find: "fetchRecalls\\(" },
      { file: "server/jobs/appJobs.ts", find: "fetchRecalls\\(" },
    ],
  },
  {
    name: "AG Grid",
    status: "claimed",
    evidence: [
      { file: "app/queue/MatchGrid.tsx", find: "<AgGridReact" },
      { file: "app/replay/ReplayGrid.tsx", find: "<AgGridReact" },
    ],
  },
  {
    name: "Model Context Protocol",
    status: "claimed",
    evidence: [
      { file: "app/api/mcp/route.ts", find: "new McpServer\\(" },
      { file: "app/api/mcp/route.ts", find: "checkText\\(" },
    ],
  },
  { name: "OpenAPI", status: "claimed", evidence: [{ file: "openapi.yaml", find: "openapi: 3" }, { file: "server/openapi.test.ts", find: "new Validator\\(" }] },
  { name: "Render", status: "claimed", evidence: [{ file: "render.yaml", find: "type: web" }] },
  { name: "Postgres (Neon)", status: "claimed", evidence: [{ file: "server/db/pg.ts", find: "new pg\\.Pool\\(" }] },
  { name: "Next.js", status: "claimed", evidence: [{ file: "package.json", find: '"next":' }] },

  { name: "Channel3", status: "cut", why: "Not built yet. Comes back only when a sweep calls it.", mentions: ["channel3"] },
  { name: "APIMatic", status: "cut", why: "Needs an account Stephen hasn't created.", mentions: ["apimatic"] },
  { name: "AG Studio", status: "cut", why: "Needs a trial licence Stephen hasn't requested.", mentions: ["ag studio", "ag-studio"] },
  { name: "Bryntum", status: "cut", why: "Not built yet.", mentions: ["bryntum"] },
  { name: "Render Workflows", status: "cut", why: "Skipped: a daily job does this.", mentions: ["render workflows"] },
  { name: "Trained scorer", status: "cut", why: "The matcher is rules. No model was trained.", mentions: ["trained scorer", "train_scorer"] },
  { name: "Hybrid search", status: "cut", why: "Trigrams and model numbers. No embeddings.", mentions: ["hybrid search", "embedding"] },
  { name: "Mobile app", status: "cut", why: "Skipped. The family page and /check work at phone width.", mentions: ["testflight", "mobile app"] },
];

export interface Files {
  read(file: string): string | null;
  /** The files a judge or a reader can see: the README and every page. */
  readable(): string[];
}

/** Comments come out first, so a call that was commented out, or a note about one, doesn't count. */
function codeOf(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** What's wrong, one line each. Empty means every claim holds. */
export function checkClaims(claims: Claim[], files: Files): string[] {
  const problems: string[] = [];
  for (const claim of claims) {
    if (claim.status !== "claimed") continue;
    if (claim.evidence.length === 0) problems.push(`${claim.name}: claimed with no evidence`);
    for (const { file, find } of claim.evidence) {
      const text = files.read(file);
      if (text === null) problems.push(`${claim.name}: ${file} doesn't exist`);
      else if (!new RegExp(find).test(codeOf(text))) problems.push(`${claim.name}: ${file} has nothing matching ${find}`);
    }
  }
  const readable = files.readable();
  for (const claim of claims) {
    if (claim.status !== "cut") continue;
    for (const file of readable) {
      const text = (files.read(file) ?? "").toLowerCase();
      for (const word of claim.mentions) {
        if (text.includes(word)) problems.push(`${claim.name} is cut, and ${file} mentions "${word}"`);
      }
    }
  }
  return problems;
}

export const builtWith = (claims: Claim[]) => claims.filter((c) => c.status === "claimed").map((c) => c.name);
