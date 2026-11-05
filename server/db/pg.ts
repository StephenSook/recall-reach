import pg from "pg";
import type { Db, Queryable } from "./types";

// DATE and TIMESTAMP (no zone) come back as the strings Postgres sends, so a calendar date
// is never shifted by the server's local time zone. TIMESTAMPTZ stays a Date.
const typeOverrides = new pg.TypeOverrides();
typeOverrides.setTypeParser(pg.types.builtins.DATE, (value: string) => value);
typeOverrides.setTypeParser(pg.types.builtins.TIMESTAMP, (value: string) => value);

/**
 * Without these, a query stalled across a Neon compute suspend would hang forever and take its job
 * with it. Idle clients leave fast, and min stays 0, so nothing here keeps the free-tier compute awake.
 */
export const POOL_CONFIG = {
  max: 5,
  min: 0,
  connectionTimeoutMillis: 15_000,
  idleTimeoutMillis: 10_000,
  query_timeout: 60_000, // the bound that holds on Neon's pooler, which ignores statement_timeout (migration 0007)
  keepAlive: true,
} satisfies pg.PoolConfig;

type Cached = { pool: pg.Pool; db: Db };
// Kept on globalThis so Next.js dev reloads reuse one pool instead of leaking connections.
const holder = globalThis as typeof globalThis & { __recallReachDb?: Cached };

function wrap(client: pg.Pool | pg.PoolClient): Queryable {
  return {
    query: async <T>(sql: string, params?: unknown[]) => {
      const res = await client.query(sql, params);
      return { rows: res.rows as T[] };
    },
    exec: async (sql: string) => {
      await client.query(sql);
    },
  };
}

/** The app's Postgres (Neon in production). Reads DATABASE_URL on first use. */
export function getDb(): Db {
  if (holder.__recallReachDb) return holder.__recallReachDb.db;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new Error("DATABASE_URL is not a valid URL; expected postgres:// or postgresql://");
  }
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new Error(`DATABASE_URL must be a postgres URL, got ${protocol}//`);
  }

  const pool = new pg.Pool({ connectionString: url, types: typeOverrides, ...POOL_CONFIG });
  // Neon closes idle connections when its compute suspends. Without a listener, that error
  // on an idle client would crash the process; the pool discards the client and reconnects.
  pool.on("error", (err) => {
    console.error("postgres idle client error:", err.message);
  });

  const db: Db = {
    ...wrap(pool),
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const out = await fn(wrap(client));
        await client.query("commit");
        client.release();
        return out;
      } catch (err) {
        try {
          await client.query("rollback");
          client.release();
        } catch (rollbackErr) {
          // A connection that cannot roll back is not safe to reuse: destroy it.
          client.release(rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)));
        }
        throw err;
      }
    },
  };
  holder.__recallReachDb = { pool, db };
  return db;
}

/** Closes the pool (scripts and tests). Safe to call when no pool exists. */
export async function closeDb(): Promise<void> {
  const cached = holder.__recallReachDb;
  holder.__recallReachDb = undefined;
  if (cached) await cached.pool.end();
}
