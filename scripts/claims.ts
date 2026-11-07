// Every technology we say we use, and the code that has to be there for it to be true. This list is the Devpost Built With
// list and the form's checkboxes: nothing outside "claimed" gets ticked, and pnpm claims fails CI if a claimed row loses its
// call, or a cut one is mentioned on a page anyone can read.
import ts from "typescript";

export type Evidence =
  /** A name this file must really call, read by the compiler's parser. */
  | { file: string; call: string }
  /** A pattern that must match the file with its comments taken out, for what isn't a call: a package, a URL, a config line. */
  | { file: string; find: string };

export type Claim =
  /** A feature keeps its row so its claim can't drift, and isn't a technology, so it stays out of Built With. */
  | { name: string; status: "claimed"; evidence: Evidence[]; feature?: true }
  | { name: string; status: "cut"; why: string; mentions: string[]; allowedIn?: string[] };

export const CLAIMS: Claim[] = [
  {
    name: "PayPal Transaction Search",
    status: "claimed",
    evidence: [
      { file: "server/paypal/transactions.ts", find: "export async function searchTransactions" },
      { file: "server/demo/seed.ts", call: "searchTransactions" },
      { file: "README.md", find: "`GET /v1/reporting/transactions`" },
    ],
  },
  {
    name: "PayPal Orders v2",
    status: "claimed",
    evidence: [
      { file: "server/paypal/orders.ts", find: "/v2/checkout/orders" },
      { file: "server/demo/seed.ts", call: "createCardOrder" },
      { file: "server/demo/liveCatch.ts", call: "getOrder" },
      { file: "server/demo/liveCatch.ts", call: "createPayPalOrder" },
      { file: "server/demo/liveCatch.ts", call: "captureOrder" },
      { file: "README.md", find: "`POST /v2/checkout/orders`" },
    ],
  },
  {
    name: "PayPal Customer Disputes",
    status: "claimed",
    evidence: [
      { file: "server/paypal/disputes.ts", find: "/v1/customer/disputes" },
      { file: "server/paypal/refunds.ts", call: "disputeOnCapture" },
      { file: "README.md", find: "`GET /v1/customer/disputes`" },
    ],
  },
  {
    name: "PayPal Payments refunds",
    status: "claimed",
    evidence: [
      { file: "server/paypal/refunds.ts", find: "/v2/payments/refunds/" },
      { file: "app/api/queue/refunds/execute/route.ts", call: "executeRefund" },
      { file: "server/paypal/orders.ts", find: "/v2/payments/captures/" },
      { file: "README.md", find: "`GET /v2/payments/captures/\\{id\\}`" },
    ],
  },
  {
    name: "PayPal webhooks",
    status: "claimed",
    evidence: [
      { file: "server/paypal/webhookHandler.ts", call: "verifyWebhook" },
      { file: "app/api/paypal/webhook/route.ts", call: "handleWebhookDelivery" },
      { file: "server/paypal/webhookHandler.ts", find: "PAYMENT.CAPTURE.COMPLETED" },
      { file: "README.md", find: "`PAYMENT\\.CAPTURE\\.COMPLETED`" },
    ],
  },
  {
    name: "PayPal Agent Toolkit",
    status: "claimed",
    evidence: [
      { file: "server/paypal/toolkitRefund.ts", find: "export function refundsThroughToolkit" },
      { file: "server/paypal/client.ts", call: "refundsThroughToolkit" },
      { file: "README.md", find: "Agent Toolkit\\), which calls" },
    ],
  },
  {
    name: "PayPal Server SDK",
    status: "claimed",
    evidence: [
      { file: "package.json", find: '"@paypal/paypal-server-sdk":' },
      { file: "server/paypal/sdkRefundRead.ts", call: "getRefund" },
      { file: "server/paypal/client.ts", call: "refundReadsThroughServerSdk" },
      { file: "README.md", find: "`GET /v2/payments/refunds/\\{id\\}`" },
    ],
  },
  {
    name: "Saved copy of Recall Replay",
    status: "claimed",
    feature: true,
    evidence: [
      { file: "server/replay/staticPage.ts", find: "export function renderStaticReplay" },
      { file: "scripts/exportReplay.ts", call: "renderStaticReplay" },
      { file: "docs/replay/index.html", find: "A saved copy of one run" },
    ],
  },
  {
    name: "Shopping agent",
    status: "claimed",
    feature: true,
    evidence: [
      { file: "app/api/shopper/run/route.ts", call: "runShopper" },
      { file: "server/agent/shopper.ts", find: "propose_listing" },
      { file: "server/sweep/channel3.ts", find: "export function channel3Listings" },
      { file: "app/api/shopper/buy/route.ts", call: "startShopperOrder" },
      { file: "server/paypal/shopperOrder.ts", call: "createPayPalOrder" },
    ],
  },
  {
    name: "Seller answers",
    status: "claimed",
    feature: true,
    evidence: [
      { file: "app/queue/SellerAnswerForm.tsx", find: "/api/queue/answers" },
      { file: "app/api/queue/answers/route.ts", call: "recordSellerAnswer" },
      { file: "server/match/sellerAnswers.ts", call: "verdictFor" },
    ],
  },
  {
    name: "Claude has no money fields",
    status: "claimed",
    feature: true,
    evidence: [{ file: "server/agent/moneyFields.test.ts", find: "amount\\|currency\\|capture\\|refund\\|payee" }],
  },
  {
    name: "Sample family page",
    status: "claimed",
    feature: true,
    evidence: [
      { file: "app/r/sample/page.tsx", call: "FamilyNotice" },
      { file: "app/r/[token]/page.tsx", call: "FamilyNotice" },
      { file: "README.md", find: "/r/sample" },
    ],
  },
  {
    name: "PayPal call panel",
    status: "claimed",
    feature: true,
    evidence: [
      { file: "server/paypal/client.ts", call: "noteCall" },
      { file: "app/queue/refunds/[id]/page.tsx", find: "<PayPalCalls" },
      { file: "app/queue/page.tsx", find: "<PayPalCalls" },
    ],
  },
  {
    name: "CPSC Product Safety Warnings",
    status: "claimed",
    evidence: [
      { file: "server/warnings/warnings.ts", find: "product_safety_warning_listing.csv" },
      { file: "instrumentation.ts", call: "refreshWarnings" },
      { file: "app/queue/page.tsx", find: "<WarningCards" },
    ],
  },
  {
    name: "PayPal reached from one folder",
    status: "claimed",
    feature: true,
    evidence: [{ file: "server/paypal/boundary.test.ts", find: "gives Claude's code no way to PayPal's" }],
  },
  {
    name: "Published numbers tested on saved records",
    status: "claimed",
    feature: true,
    evidence: [
      { file: "server/replay/savedRecords.test.ts", call: "runReplay" },
      { file: "server/eval/measure.test.ts", find: "the committed results are what the code produces now" },
    ],
  },
  {
    name: "Published defects",
    status: "claimed",
    feature: true,
    evidence: [
      { file: "app/evidence/defects/page.tsx", find: "What went wrong" },
      { file: "README.md", find: "evidence/defects" },
    ],
  },
  {
    name: "APIMatic Context Plugin",
    status: "claimed",
    evidence: [{ file: "docs/apimatic-context-plugin.md", find: "server-sdk-context-plugin-preview" }],
  },
  {
    name: "Claude",
    status: "claimed",
    evidence: [
      { file: "server/agent/claude.ts", find: "@anthropic-ai/sdk" },
      { file: "server/agent/recallAgent.ts", call: "askClaude" },
      { file: "server/agent/recallQuestion.ts", call: "askClaude" },
    ],
  },
  {
    name: "CPSC Recalls API",
    status: "claimed",
    evidence: [
      { file: "server/cpsc/fetch.ts", find: "saferproducts\\.gov" },
      { file: "server/cpsc/pull.ts", call: "fetchRecalls" },
      { file: "server/jobs/appJobs.ts", call: "fetchRecalls" },
    ],
  },
  {
    name: "AG Grid",
    status: "claimed",
    evidence: [
      { file: "app/queue/MatchGrid.tsx", call: "AgGridReact" },
      { file: "app/replay/ReplayGrid.tsx", call: "AgGridReact" },
    ],
  },
  {
    name: "Model Context Protocol",
    status: "claimed",
    evidence: [
      { file: "app/api/mcp/route.ts", call: "McpServer" },
      { file: "app/api/mcp/route.ts", call: "checkText" },
      { file: "app/api/mcp/route.ts", call: "readPublicRecall" },
    ],
  },
  { name: "OpenAPI", status: "claimed", evidence: [{ file: "openapi.yaml", find: "openapi: 3" }, { file: "server/openapi.test.ts", call: "Validator" }] },
  {
    name: "Channel3",
    status: "claimed",
    evidence: [
      { file: "server/sweep/channel3.ts", find: "search_products" },
      { file: "instrumentation.ts", call: "channel3Search" },
      { file: "app/sweep/[recallNumber]/page.tsx", call: "readSweep" },
      { file: "app/sweep/[recallNumber]/page.tsx", call: "sweepView" },
    ],
  },
  {
    name: "Bryntum Scheduler",
    status: "claimed",
    evidence: [
      { file: "package.json", find: '"@bryntum/scheduler-community":' },
      { file: "app/queue/recalls/RefundTimeline.tsx", call: "BryntumScheduler" },
      { file: "app/queue/recalls/[recallNumber]/page.tsx", call: "timelineFor" },
    ],
  },
  { name: "Render", status: "claimed", evidence: [{ file: "render.yaml", find: "type: web" }] },
  { name: "Postgres (Neon)", status: "claimed", evidence: [{ file: "server/db/pg.ts", call: "Pool" }] },
  { name: "Next.js", status: "claimed", evidence: [{ file: "package.json", find: '"next":' }] },

  { name: "AG Studio", status: "cut", why: "Needs a trial licence Stephen hasn't requested.", mentions: ["ag studio", "ag-studio"] },
  { name: "Render Workflows", status: "cut", why: "Skipped: a daily job does this.", mentions: ["render workflows"] },
  { name: "Trained scorer", status: "cut", why: "The matcher is rules. No model was trained.", mentions: ["trained scorer", "train_scorer"] },
  { name: "Hybrid search", status: "cut", why: "Trigrams and model numbers. No embeddings.", mentions: ["hybrid search", "embedding"] },
  { name: "Mobile app", status: "cut", why: "Skipped. The family page and /check work at phone width.", mentions: ["testflight", "mobile app"] },
];

export interface Files {
  read(file: string): string | null;
  /** The files a judge or a reader can see, or that hand text to a page: the README, every page, and the server code behind them. */
  readable(): string[];
}

const isCode = (file: string) => /\.tsx?$/.test(file);
const parsed = (file: string, text: string) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** The code with its comments gone, from the compiler's own scanner, so nothing hiding after a quote can pass as code. */
function withoutComments(file: string, text: string): string {
  if (!isCode(file)) return text;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, file.endsWith("x") ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard, text);
  let kept = "";
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind !== ts.SyntaxKind.SingleLineCommentTrivia && kind !== ts.SyntaxKind.MultiLineCommentTrivia) kept += scanner.getTokenText();
  }
  return kept;
}

/** The names this file really calls: calls, new, and JSX elements. Not a definition, an import, a comment or a string. */
function namesCalled(file: string, text: string): Set<string> {
  const names = new Set<string>();
  const lastName = (e: ts.Node): string | null => (ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = lastName(node.expression);
      if (name) names.add(name);
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = lastName(node.tagName);
      if (name) names.add(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed(file, text));
  return names;
}

/** What a reader could see from this file. In code, that is strings and JSX text: not comments or names. */
function visibleText(file: string, text: string): string {
  if (!isCode(file)) return text;
  const parts: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isJsxText(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) parts.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(parsed(file, text));
  return parts.join("\n");
}

/** What's wrong, one line each. Empty means every claim holds. */
export function checkClaims(claims: Claim[], files: Files): string[] {
  const problems: string[] = [];
  for (const claim of claims) {
    if (claim.status !== "claimed") continue;
    if (claim.evidence.length === 0) problems.push(`${claim.name}: claimed with no evidence`);
    for (const evidence of claim.evidence) {
      const text = files.read(evidence.file);
      if (text === null) problems.push(`${claim.name}: ${evidence.file} doesn't exist`);
      else if ("call" in evidence) {
        if (!namesCalled(evidence.file, text).has(evidence.call)) problems.push(`${claim.name}: ${evidence.file} never calls ${evidence.call}`);
      } else if (!new RegExp(evidence.find).test(withoutComments(evidence.file, text))) {
        problems.push(`${claim.name}: ${evidence.file} has nothing matching ${evidence.find}`);
      }
    }
  }
  const readable = files.readable();
  for (const claim of claims) {
    if (claim.status !== "cut") continue;
    for (const file of readable) {
      if (claim.allowedIn?.some((prefix) => file.startsWith(prefix))) continue;
      const seen = visibleText(file, files.read(file) ?? "").toLowerCase();
      for (const word of claim.mentions) {
        if (seen.includes(word)) problems.push(`${claim.name} is cut, and ${file} mentions "${word}"`);
      }
    }
  }
  return problems;
}

export const builtWith = (claims: Claim[]) => claims.filter((c) => c.status === "claimed" && !c.feature).map((c) => c.name);
