import { PGlite, types } from "@electric-sql/pglite";
import type { Db, Queryable } from "../server/db/types";

/**
 * An in-process Postgres (PGlite) behind the same Db interface the app uses with Neon.
 * DATE and TIMESTAMP come back as strings, matching the pg pool's type overrides.
 */
export async function testDb(): Promise<Db & { close(): Promise<void> }> {
  const pg = await PGlite.create({
    parsers: {
      [types.DATE]: (value: string) => value,
      [types.TIMESTAMP]: (value: string) => value,
    },
  });
  const wrap = (q: Pick<PGlite, "query" | "exec">): Queryable => ({
    query: async <T>(sql: string, params?: unknown[]) => {
      const res = await q.query<T>(sql, params);
      return { rows: res.rows };
    },
    exec: async (sql: string) => {
      await q.exec(sql);
    },
  });
  return {
    ...wrap(pg),
    transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))),
    close: () => pg.close(),
  };
}
