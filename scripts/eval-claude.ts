// Asks Claude about every held-out pair the matcher sends to a seller, and caches what it said. CI reads the cache and
// never spends anything. Claude's finding changes nothing in the queue: this measures what a seller would read.
//   ANTHROPIC_API_KEY=... pnpm exec tsx scripts/eval-claude.ts
import { readFileSync, writeFileSync } from "node:fs";
import { PGlite, types } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { agentClientFromEnv, spentToday } from "../server/agent/claude";
import { runAgentOnRecord } from "../server/agent/recallAgent";
import type { Db, Queryable } from "../server/db/types";
import { decidePairs, parsePairs, scoreClaude, type ClaudeFinding } from "../server/eval/measure";

async function main() {
  const client = agentClientFromEnv();
  if (!client) throw new Error("ANTHROPIC_API_KEY is not set");
  const pg = await PGlite.create({ extensions: { pg_trgm }, parsers: { [types.DATE]: (v: string) => v, [types.TIMESTAMP]: (v: string) => v } });
  const wrap = (q: Pick<PGlite, "query" | "exec">): Queryable => ({
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await q.query<T>(sql, params)).rows }),
    exec: async (sql: string) => {
      await q.exec(sql);
    },
  });
  const db: Db = { ...wrap(pg), transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))) as never };
  const heldOut = parsePairs(readFileSync("eval/pairs.csv", "utf8")).filter((p) => p.split === "held_out");
  const decided = await decidePairs(db, heldOut, JSON.parse(readFileSync("eval/recalls.json", "utf8")));

  const now = new Date();
  const findings: Record<string, ClaudeFinding> = {};
  const failures: string[] = [];
  for (const pair of heldOut) {
    const d = decided.get(pair.pairId);
    if (!d || d.verdict === "CLEARED") continue; // it never reached a seller, so the product would not ask
    const { rows } = await db.query<{ id: string; shop_id: string }>("select id, shop_id from order_lines where order_number = $1", [pair.pairId]);
    const line = rows[0];
    // Only the labelled recall: other recalls this title comes near have no label to score against.
    await db.query("delete from recall_matches m using recalls r where r.recall_id = m.recall_id and m.order_line_id = $1 and r.recall_number <> $2", [line.id, pair.recallNumber]);
    const summary = await runAgentOnRecord(db, client, { shopId: line.shop_id, recordId: line.id, now });
    if (summary.unavailable > 0 || summary.overBudget > 0) {
      failures.push(pair.pairId);
      console.error(`no answer for ${pair.pairId}: ${summary.failedStatuses.join(",") || "no status"}`);
      continue;
    }
    const { rows: run } = await db.query<{ finding: ClaudeFinding | null }>(
      "select a.finding from recall_matches m join agent_runs a on a.id = m.agent_run_id where m.order_line_id = $1",
      [line.id],
    );
    findings[pair.pairId] = run[0]?.finding ?? "NONE";
    console.log(`${pair.pairId} ${pair.label} ${d.verdict} -> ${findings[pair.pairId]}`);
  }
  const spent = await spentToday(db, now);
  const asked = Object.keys(findings).length;
  writeFileSync("eval/claude-held-out.json", `${JSON.stringify({ model: "claude-sonnet-5-5", asked, findings, summary: scoreClaude(heldOut, findings) }, null, 1)}\n`);
  console.log(`asked ${asked}, failed ${failures.length}, cost $${(spent / 1_000_000).toFixed(3)}`);
  await pg.close();
  process.exitCode = failures.length > 0 ? 1 : 0;
}

void main();
