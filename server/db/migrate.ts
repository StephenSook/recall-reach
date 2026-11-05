import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "./types";

export interface Migration {
  name: string;
  sql: string;
}

const MIGRATIONS_DIR = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
// Serializes concurrent migrators (two deploys starting at once) on the same database.
const ADVISORY_LOCK_KEY = 7262518;

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((name) => MIGRATION_FILE.test(name))
    .sort()
    .map((name) => ({ name, sql: readFileSync(`${dir}/${name}`, "utf8") }));
}

/**
 * Applies migrations not yet recorded in schema_migrations, each in its own transaction.
 * A failing migration rolls back completely and stops the run. Returns the names applied.
 */
export async function migrate(db: Db, migrations: Migration[] = loadMigrations()): Promise<string[]> {
  await db.exec(
    "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const applied: string[] = [];
  for (const m of migrations) {
    const ran = await db
      .transaction(async (tx) => {
        await tx.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK_KEY]);
        const { rows } = await tx.query("select 1 from schema_migrations where name = $1", [m.name]);
        if (rows.length > 0) return false;
        await tx.exec(m.sql);
        await tx.query("insert into schema_migrations (name) values ($1)", [m.name]);
        return true;
      })
      .catch((err: unknown) => {
        throw new Error(`migration ${m.name} failed: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err,
        });
      });
    if (ran) applied.push(m.name);
  }
  return applied;
}
