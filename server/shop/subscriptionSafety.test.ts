import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function sources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? sources(join(root, e.name)) : /\.tsx?$/.test(e.name) && !e.name.includes(".test.") ? [join(root, e.name)] : []);
}

describe("subscriptions cannot gate safety", () => {
  it("billing entry points use only the billing pool for subscription work", () => {
    for (const file of ["server/shop/subscriptionHttp.ts", "app/queue/ShopSubscription.tsx"]) {
      const code = readFileSync(file, "utf8");
      expect(code, file).toMatch(/import\s*\{\s*getBillingDb\s*\}\s*from/);
      expect(code, file).toMatch(/getBillingDb\(\)/);
      expect(code, file).not.toMatch(/\bgetDb\b/);
    }
    const webhook = readFileSync("app/api/paypal/webhook/route.ts", "utf8");
    expect(webhook).toMatch(/import\s*\{[^}]*\bgetBillingDb\b[^}]*\}\s*from/);
    expect(webhook).toMatch(/withCallLog\(getBillingDb\(\), null, \(\) => syncSubscriptionEvent\(getBillingDb\(\),/);
    expect(webhook.match(/getBillingDb\(\)/g)).toHaveLength(2);
    expect(webhook).toContain("db: getDb(),");
    expect(webhook).toMatch(/withCallLog\(getDb\(\), null, \(\) => catchLiveSale\(getDb\(\),/);
    expect(webhook).toMatch(/withCallLog\(getDb\(\), null, \(\) => confirmRevoked\(getDb\(\),/);
  });

  it("no recall check, notice, refund or receipt path reads billing state, including local imports", () => {
    const entries = ["server/match", "server/notice", "server/safetyReceipt", "server/queue", "server/jobs", "server/import", "app/api/queue", "app/api/check", "app/api/safety-receipts", "app/api/family", "app/r", "app/recall", "app/api/recalls"];
    const todo = [...entries.filter(existsSync).flatMap(sources), "server/paypal/refunds.ts", "server/paypal/refundAction.ts", "server/paypal/webhookHandler.ts"].filter(existsSync);
    const seen = new Set<string>();
    while (todo.length) {
      const file = resolve(todo.pop()!);
      if (seen.has(file)) continue;
      seen.add(file);
      let code = readFileSync(file, "utf8");
      if (file === resolve("server/paypal/webhookHandler.ts")) {
        // Only event names are shared with the safety webhook, never billing operations.
        const routingImport = 'import { BILLING_EVENTS } from "../shop/subscription";';
        expect(code.split(routingImport), file).toHaveLength(2);
        code = code.replace(routingImport, "");
      }
      expect(code, file).not.toMatch(/\bimport\s+[^;"']*\bgetBillingDb\b/);
      expect(code, file).not.toMatch(/(?:from|import\()\s*["'][^"']*(?:[Ss]ubscription)/);
      // Shared retention constants are imported by safety code. Only the purge's nonblocking row selection may read billing rows.
      if (file === resolve("server/privacy/retention.ts")) {
        const withoutPurgeSelection = code.replace(/select shop_id from shop_subscriptions\s+where \(status is not null or started_at is not null\) and updated_at < \$1::timestamptz - make_interval\(hours => \$2\)\s+for update skip locked/gi, "");
        expect(withoutPurgeSelection, file).not.toMatch(/\bselect\b[^`]*\b(?:shop_subscriptions|paypal_subscription_refs)\b/i);
      } else if (file === resolve("server/import/ownFile.ts")) {
        const withoutPurgeSelection = code
          .replace("select shop_id from shop_subscriptions where shop_id = any($1::uuid[]) for update skip locked", "")
          .replace("not exists (select 1 from shop_subscriptions where shop_id = shops.id)", "");
        expect(withoutPurgeSelection, file).not.toMatch(/shop_subscriptions|paypal_subscription_refs/);
      } else {
        expect(code, file).not.toMatch(/shop_subscriptions|paypal_subscription_refs/);
      }
      for (const match of code.matchAll(/(?:from\s+|import\s*\()(["'])([^"']+)\1/g)) {
        const spec = match[2];
        if (!spec.startsWith(".") && !spec.startsWith("@/")) continue;
        const base = spec.startsWith("@/") ? resolve(spec.slice(2)) : resolve(dirname(file), spec);
        const dependency = [base + ".ts", base + ".tsx", join(base, "index.ts")].find(existsSync);
        if (dependency) todo.push(dependency);
      }
    }
    expect(seen.size).toBeGreaterThan(30);
    expect(seen.has(resolve("server/paypal/webhookHandler.ts"))).toBe(true);
  });
});
