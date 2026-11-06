// Runs the matcher eval on eval/pairs.csv through the real pipeline, in a throwaway database, and writes the results.
// A test fails if the committed results stop matching what the code produces.
//   pnpm eval
import { readFileSync, writeFileSync } from "node:fs";
import { PGlite, types } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import type { Db, Queryable } from "../server/db/types";
import { parsePairs, runEval } from "../server/eval/measure";

async function main() {
  const pg = await PGlite.create({ extensions: { pg_trgm }, parsers: { [types.DATE]: (v: string) => v, [types.TIMESTAMP]: (v: string) => v } });
  const wrap = (q: Pick<PGlite, "query" | "exec">): Queryable => ({
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await q.query<T>(sql, params)).rows }),
    exec: async (sql: string) => {
      await q.exec(sql);
    },
  });
  const db: Db = { ...wrap(pg), transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))) as never };
  const results = await runEval(db, { pairs: parsePairs(readFileSync("eval/pairs.csv", "utf8")), recalls: JSON.parse(readFileSync("eval/recalls.json", "utf8")) });
  writeFileSync("eval/results.json", `${JSON.stringify(results, null, 1)}\n`);
  const show = (name: string, s: (typeof results.heldOut)["matcher"]) =>
    console.log(`${name}: false alarms ${s.falseAlarms.k}/${s.falseAlarms.n}, could reach a family ${s.couldReachFamily.k}/${s.couldReachFamily.n}, abstained ${s.abstained.k}/${s.abstained.n}, guessed ${s.guessed.k}/${s.guessed.n}, missed ${s.missed.k}/${s.missed.n}`);
  console.log(`${results.pairs} pairs, ${results.recalls} recalls. Held out:`);
  show("matcher ", results.heldOut.matcher);
  show("baseline", results.heldOut.baseline);
  console.log("Train:");
  show("matcher ", results.train.matcher);
  show("baseline", results.train.baseline);
  await pg.close();
}

void main();
