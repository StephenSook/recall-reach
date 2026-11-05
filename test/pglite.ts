import { PGlite, types } from "@electric-sql/pglite";
import { afterAll } from "vitest";
import type { Db, Queryable } from "../server/db/types";

// One in-process Postgres (PGlite) per test file, because Vitest isolates this module per file.
// Starting one costs 7 to 35 s on a loaded 8 GB Mac and holds tens of MB (measured 2026-11-05);
// resetting one costs milliseconds. PGlite's clone() is not used: it drops the parsers below.
let shared: Promise<PGlite> | undefined;

function instance(): Promise<PGlite> {
  shared ??= PGlite.create({
    parsers: {
      [types.DATE]: (value: string) => value,
      [types.TIMESTAMP]: (value: string) => value,
    },
  });
  return shared;
}

afterAll(async () => {
  if (shared) await (await shared).close();
  shared = undefined;
});

/**
 * An empty Postgres behind the same Db interface the app uses with Neon. Each call wipes the file's
 * shared instance, so a test sees none of the previous test's data. DATE and TIMESTAMP come back as
 * strings, matching the pg pool's type overrides. close() does nothing: the instance is reused and
 * closes when the file ends. It stays so a test's setup and teardown read the same either way.
 */
export async function testDb(): Promise<Db & { close(): Promise<void> }> {
  const pg = await instance();
  await pg.exec("drop schema public cascade; create schema public;");
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
    close: async () => {},
  };
}
