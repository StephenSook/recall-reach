// The shopping agent's recorded runs, for /evidence/shopper. A run is kept only when it is one of the page's own example
// asks with its budget, so nothing a visitor typed is ever published.
import type { Queryable } from "../db/types";
import type { ShopperStep } from "../agent/shopper";

import { SHOPPER_EXAMPLES } from "./examples";

export { SHOPPER_EXAMPLES };

const KEPT = 5;

export const isShopperExample = (ask: string, budgetCents: number) => SHOPPER_EXAMPLES.some((e) => e.ask === ask && e.budget * 100 === budgetCents);

export interface ExampleRunInput {
  ask: string;
  budgetCents: number;
  ranAt: Date;
  outcome: string;
  models: string[];
  steps: ShopperStep[];
  blocked: { title: string; priceCents: number; recalls: { number: string; title: string; url: string | null }[] }[];
  pick: { title: string; brand: string | null; priceCents: number; recallsChecked: number; from: string | null; similar: number } | null;
  slipId: string | null;
  offerExpiresAt: Date | null;
}

export interface ExampleRun extends Omit<ExampleRunInput, "ranAt" | "offerExpiresAt"> {
  ranAt: string;
  offerExpiresAt: string | null;
  paidAt: string | null;
}

/** False, recording nothing, unless this is one of the page's own examples. */
export async function recordExampleRun(db: Queryable, run: ExampleRunInput): Promise<boolean> {
  if (!isShopperExample(run.ask, run.budgetCents)) return false;
  await db.query(
    `insert into shopper_example_runs (ran_at, ask, budget_cents, outcome, models, steps, blocked, pick, slip_id, offer_expires_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10)`,
    [run.ranAt.toISOString(), run.ask, run.budgetCents, run.outcome, run.models, JSON.stringify(run.steps), JSON.stringify(run.blocked), run.pick ? JSON.stringify(run.pick) : null, run.slipId, run.offerExpiresAt?.toISOString() ?? null],
  );
  await db.query("delete from shopper_example_runs where id not in (select id from shopper_example_runs order by ran_at desc, id limit $1)", [KEPT]);
  return true;
}

/** When PayPal's order for a recorded run's offer reads back as completed. */
export async function markExamplePaid(db: Queryable, slipId: string, at: Date): Promise<void> {
  await db.query("update shopper_example_runs set paid_at = coalesce(paid_at, $2) where slip_id = $1", [slipId, at.toISOString()]);
}

const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).toISOString());

export async function latestExampleRun(db: Queryable): Promise<ExampleRun | null> {
  const { rows } = await db.query<Record<string, unknown>>("select * from shopper_example_runs order by ran_at desc, id limit 1");
  const r = rows[0];
  if (!r) return null;
  return {
    ask: String(r.ask),
    budgetCents: Number(r.budget_cents),
    ranAt: iso(r.ran_at) as string,
    outcome: String(r.outcome),
    models: (r.models as string[]) ?? [],
    steps: r.steps as ShopperStep[],
    blocked: r.blocked as ExampleRun["blocked"],
    pick: (r.pick as ExampleRun["pick"]) ?? null,
    slipId: (r.slip_id as string | null) ?? null,
    offerExpiresAt: iso(r.offer_expires_at),
    paidAt: iso(r.paid_at),
  };
}
