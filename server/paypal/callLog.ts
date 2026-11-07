// What the app asked PayPal, kept for the one shop it was for, so it can see nothing is mocked. The call's shape only, with
// PayPal's debug id: no payload and no id in a path. Purged with the rest of PayPal's data, and never sent anywhere.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Queryable } from "../db/types";

export interface PayPalCall {
  method: string;
  template: string;
  status: number;
  ms: number;
  debugId: string | null;
}

interface Scope {
  shopId: string | null;
  calls: PayPalCall[];
}

const MAX_SHOWN = 40;
const scope = new AsyncLocalStorage<Scope>();

export function noteCall(call: PayPalCall): void {
  scope.getStore()?.calls.push(call);
}

/** For a request that only learns the shop partway through, as a webhook does. */
export function callsBelongTo(shopId: string): void {
  const current = scope.getStore();
  if (current) current.shopId = shopId;
}

/** Runs `run` and keeps what it asked PayPal. A failure to keep it never costs the action. */
export async function withCallLog<T>(db: Queryable, shopId: string | null, run: () => Promise<T>): Promise<T> {
  const here: Scope = { shopId, calls: [] };
  try {
    return await scope.run(here, run);
  } finally {
    if (here.shopId && here.calls.length > 0) {
      await db
        .query(
          `insert into paypal_calls (shop_id, method, path_template, status, ms, debug_id)
           select $1, c.method, c.template, c.status, c.ms, c.debug from jsonb_to_recordset($2::jsonb) as c(method text, template text, status int, ms int, debug text)`,
          [here.shopId, JSON.stringify(here.calls.map((c) => ({ method: c.method, template: c.template, status: c.status, ms: c.ms, debug: c.debugId })))],
        )
        .catch((err: unknown) => console.error("paypal call log failed:", err instanceof Error ? err.name : "unknown error"));
    }
  }
}

export async function readCalls(db: Queryable, shopId: string): Promise<PayPalCall[]> {
  const { rows } = await db.query<{ method: string; path_template: string; status: number; ms: number; debug_id: string | null }>(
    "select method, path_template, status, ms, debug_id from paypal_calls where shop_id = $1 order by id desc limit $2",
    [shopId, MAX_SHOWN],
  );
  return rows.map((r) => ({ method: r.method, template: r.path_template, status: r.status, ms: r.ms, debugId: r.debug_id }));
}
