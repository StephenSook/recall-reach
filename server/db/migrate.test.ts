import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { loadMigrations, migrate } from "./migrate";
import { POOL_CONFIG } from "./pg";

type TestDb = Awaited<ReturnType<typeof testDb>>;

describe("migrate", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await testDb();
  });
  afterEach(async () => {
    await db.close();
  });

  async function tableExists(name: string): Promise<boolean> {
    const { rows } = await db.query<{ t: string | null }>("select to_regclass($1)::text as t", [name]);
    return rows[0].t !== null;
  }

  it("loads the repo's numbered .sql migrations in order", () => {
    const names = loadMigrations().map((m) => m.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toEqual([...names].sort());
    for (const n of names) expect(n).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
  });

  it("applies every repo migration to an empty database and records it", async () => {
    const applied = await migrate(db);
    expect(applied).toEqual(loadMigrations().map((m) => m.name));
    const { rows } = await db.query<{ name: string }>("select name from schema_migrations order by name");
    expect(rows.map((r) => r.name)).toEqual(applied);
    expect(await tableExists("recalls")).toBe(true);
    expect(await tableExists("cpsc_pulls")).toBe(true);
  });

  it("sets a role default statement timeout, shorter than the client's timeout", async () => {
    await migrate(db);
    const { rows } = await db.query<{ rolconfig: string[] | null }>(
      "select rolconfig from pg_roles where rolname = current_user",
    );
    expect(rows[0].rolconfig).toContain("statement_timeout=45s");
    expect(45_000).toBeLessThan(POOL_CONFIG.query_timeout);
  });

  it("applies nothing when run a second time", async () => {
    await migrate(db);
    expect(await migrate(db)).toEqual([]);
  });

  it("rolls back a failing migration, keeps earlier ones, and does not record it", async () => {
    const run = migrate(db, [
      { name: "0001_ok.sql", sql: "create table ok_table (id int);" },
      { name: "0002_bad.sql", sql: "create table half_done (id int); select * from no_such_table;" },
    ]);
    await expect(run).rejects.toThrow(/0002_bad\.sql/);
    expect(await tableExists("ok_table")).toBe(true);
    expect(await tableExists("half_done")).toBe(false);
    const { rows } = await db.query<{ name: string }>("select name from schema_migrations");
    expect(rows.map((r) => r.name)).toEqual(["0001_ok.sql"]);
  });
});
