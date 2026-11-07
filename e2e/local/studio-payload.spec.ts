// What AG Studio's agent sends from the page, captured in a real browser. AG Studio's own harness runs its own tools
// on the page's data, and only the model is scripted, so every payload here is exactly what the adapter would send.
// None may hold a value PayPal returned. PayPal is faked here, and the PayPal-sourced tables hold what it returned.
import { expect, test, type Page, type Route } from "@playwright/test";
import pg from "pg";
import { fromClaude, readTurn, type ClaudeAnswer } from "../../server/studio/turn";

type Item = { type: string; name?: string; callId?: string; output?: string };
type Body = { input: Item[]; tools?: { name: string }[] };

const FIELDS = ["recallNumber", "outcome", "itemTitle", "recallTitle", "recallDate", "recallYear"].map((id) => ({ field: { id: `recalls.${id}` } }));
const PLANTED = ["PLANTEDORDERID77", "PLANTEDCAPTURE77", "PLANTED PAYPAL ITEM NAME", "PLANTEDDEBUGID01"];
const PLANTED_CENTS = 876543;
const PLANTED_AT = "2031-07-19T04:05:06Z";
const SUMMARY = "Read 50 rows.";
/** The shop's own source records. Tables the app derives from them, like Replay's rows, are never trusted to clear a value. */
const SHOP_SOURCES = ["shop_items", "order_lines"];

/** Stands in for the model: delegate to the data agent, which reads 50 rows of every field, then finish. */
function scripted(body: Body): ClaudeAnswer["content"] {
  const tools = new Set((body.tools ?? []).map((t) => t.name));
  const answered = (name: string) => {
    const ids = new Set(body.input.filter((i) => i.type === "function_call" && i.name === name).map((i) => i.callId));
    return body.input.some((i) => i.type === "function_call_output" && ids.has(i.callId));
  };
  const call = (name: string, input: unknown) => [{ type: "tool_use", id: `scripted-${name}-${body.input.length}`, name, input }];
  if (tools.has("execute_query")) {
    if (!answered("execute_query")) return call("execute_query", { query: { kind: "apiQuery", variant: "projection", projection: FIELDS, limit: { count: 50 } } });
    return call("complete_task", { summary: SUMMARY, artifacts: [] });
  }
  if (tools.has("delegate_to") && !answered("delegate_to")) return call("delegate_to", { type: { id: "data" }, instructions: "Read 50 rows of every field." });
  return [{ type: "text", text: "Done." }];
}

async function capture(page: Page): Promise<string[]> {
  const payloads: string[] = [];
  await page.route("**/api/studio/turn", async (route: Route) => {
    const raw = route.request().postData() ?? "";
    payloads.push(raw);
    const body = JSON.parse(raw) as Body;
    const turn = readTurn(body);
    if ("error" in turn) return route.fulfill({ status: 400, json: { error: turn.error } });
    const content = scripted(body);
    const answer: ClaudeAnswer = { id: `msg-${payloads.length}`, model: "scripted", stop_reason: content[0].type === "tool_use" ? "tool_use" : "end_turn", content, usage: { input_tokens: 0, output_tokens: 0 } };
    await route.fulfill({ json: fromClaude(turn, answer) });
  });
  return payloads;
}

/** What a value could look like if it reached a payload: strings, cents as dollars, and timestamps to the minute. */
function forms(rows: Record<string, unknown>[]): Set<string> {
  const found = new Set<string>();
  const walk = (v: unknown, key = ""): void => {
    if (v instanceof Date) {
      const iso = v.toISOString();
      found.add(iso.slice(0, 16));
      found.add(iso.slice(0, 16).replace("T", " "));
    } else if (typeof v === "number") {
      if (key.endsWith("_cents") && v >= 100) found.add((v / 100).toFixed(2));
    } else if (typeof v === "string") {
      // A date alone would match CPSC's own recall dates, which the page shows. Anything longer is PayPal's own.
      if (/^\d+\.\d{2}$/.test(v) || (v.length >= 6 && !/^\d{4}-\d{2}-\d{2}$/.test(v))) found.add(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? v.slice(0, 16) : v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object" && !Buffer.isBuffer(v)) for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  rows.forEach((r) => walk(r));
  return found;
}

/** Every value in tables labelled PayPal's, less any the shop's own records hold too: a shop's own item title sent to PayPal comes back in PayPal's answer, and is still the shop's. */
async function payPalValues(db: pg.Client): Promise<string[]> {
  const labelled = async (label: string) =>
    (await db.query<{ t: string }>("select c.relname as t from pg_class c where c.relkind = 'r' and obj_description(c.oid, 'pg_class') = $1", [label])).rows.map((r) => r.t);
  const shopOwned = await labelled("data-source: shop-owned");
  for (const t of SHOP_SOURCES) expect(shopOwned).toContain(t);
  const read = async (tables: string[]) => {
    const rows: Record<string, unknown>[] = [];
    for (const t of tables) rows.push(...(await db.query(`select * from ${t}`)).rows);
    return forms(rows);
  };
  const shops = await read(SHOP_SOURCES);
  return [...(await read(await labelled("data-source: paypal")))].filter((v) => !shops.has(v));
}

/** The output AG Studio's tool gave for a named call, from the payloads. */
const outputOf = (payloads: string[], name: string): string | undefined => {
  for (const raw of [...payloads].reverse()) {
    const input = (JSON.parse(raw) as Body).input;
    const ids = new Set(input.filter((i) => i.type === "function_call" && i.name === name).map((i) => i.callId));
    const found = input.find((i) => i.type === "function_call_output" && ids.has(i.callId));
    if (found) return found.output;
  }
  return undefined;
};

test("AG Studio's agent sends the model no value PayPal returned", async ({ page }) => {
  // A demo shop, so the PayPal-sourced tables hold what (fake) PayPal returned, then a Replay for the dashboard to show.
  await page.goto("/");
  await page.getByRole("button", { name: "Try it as a demo shop" }).click();
  await expect(page).toHaveURL(/\/queue$/, { timeout: 60_000 });
  await page.goto("/replay");
  await page.getByRole("button", { name: /^Run/ }).first().click();
  await expect(page).toHaveURL(/\/replay\/[0-9a-f-]+$/, { timeout: 120_000 });

  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const shop = (await db.query<{ id: string }>("select id from shops where kind = 'DEMO' order by created_at desc limit 1")).rows[0].id;
    await db.query(
      `insert into paypal_payments (shop_id, order_id, capture_id, capture_status, captured_at, amount_cents, currency, items)
       values ($1, $2, $3, 'COMPLETED', $4, $5, 'USD', $6::jsonb)`,
      [shop, PLANTED[0], PLANTED[1], PLANTED_AT, PLANTED_CENTS, JSON.stringify([{ name: PLANTED[2], sku: "PLANTED-SKU-77" }])],
    );
    await db.query("insert into paypal_calls (shop_id, method, path_template, status, ms, debug_id) values ($1, 'GET', '/PLANTED-PAYPAL-PATH', 200, 1, $2)", [shop, PLANTED[3]]);
    const values = await payPalValues(db);
    for (const p of [...PLANTED, (PLANTED_CENTS / 100).toFixed(2), PLANTED_AT.slice(0, 16)]) expect(values).toContain(p);

    // A PayPal value copied into the rows the page reads stays forbidden: the check never trusts a derived table.
    await db.query("begin");
    await db.query("update replay_rows set item_title = $1 where run_id = (select id from replay_runs order by created_at desc, id limit 1)", [PLANTED[2]]);
    expect(await payPalValues(db)).toContain(PLANTED[2]);
    await db.query("rollback");

    const recallNumbers = (await db.query<{ n: string }>("select recall_number as n from replay_rows where run_id = (select id from replay_runs order by created_at desc, id limit 1)")).rows.map((r) => r.n);

    const payloads = await capture(page);
    await page.goto("/studio");
    await page.getByPlaceholder("Ask the AI Assistant...").fill("Show me the recalls");
    await page.getByRole("button", { name: "Send" }).click();

    // The run finishes: the lead hears the data agent's own summary back, so complete_task was taken as valid.
    await expect.poll(() => outputOf(payloads, "delegate_to") ?? "", { timeout: 60_000 }).toContain(SUMMARY);
    expect(outputOf(payloads, "delegate_to")).toMatch(/^\{"success":true/);
    await page.waitForTimeout(2000); // a retry, if one went out, would show up here
    // Lead delegates, data agent queries, data agent finishes, lead answers. No retries.
    expect(payloads).toHaveLength(4);

    // Not vacuous: the data agent's query answer, with real rows from the dashboard, went out in a payload.
    const queryAnswer = outputOf(payloads, "execute_query");
    expect(queryAnswer).toMatch(/^\{"success":true/);
    expect(recallNumbers.filter((n) => queryAnswer?.includes(n)).length).toBeGreaterThan(10);

    const all = payloads.join("\n");
    expect(values.filter((v) => all.includes(v) || all.includes(JSON.stringify(v).slice(1, -1)))).toEqual([]);
    // Nor any PayPal field by name.
    expect(all).not.toMatch(/capture_id|order_id|debug_id|amount_cents|payer_|payee|PayPal/i);
  } finally {
    await db.end();
  }
});
