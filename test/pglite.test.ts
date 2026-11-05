import { describe, expect, it } from "vitest";
import { testDb } from "./pglite";

describe("testDb", () => {
  it("reuses one Postgres instance within a test file", async () => {
    // A new instance costs 7 to 35 s on a loaded 8 GB Mac (measured); a reset costs milliseconds.
    const startedAt = async () => {
      const db = await testDb();
      const { rows } = await db.query<{ t: Date }>("select pg_postmaster_start_time() as t");
      await db.close();
      return rows[0].t.getTime();
    };
    expect(await startedAt()).toBe(await startedAt());
  });

  it("starts every test from an empty database", async () => {
    const first = await testDb();
    await first.exec("create table leftover (id int); insert into leftover values (1);");
    await first.close();

    const second = await testDb();
    const { rows } = await second.query<{ t: string | null }>("select to_regclass('leftover')::text as t");
    expect(rows[0].t).toBeNull();
    await second.close();
  });

  it("restarts identity sequences along with the tables", async () => {
    for (const expected of [1, 1]) {
      const db = await testDb();
      await db.exec("create table seq_check (id bigint generated always as identity primary key, v text);");
      const { rows } = await db.query<{ id: number }>("insert into seq_check (v) values ('x') returning id");
      expect(Number(rows[0].id)).toBe(expected);
      await db.close();
    }
  });

  it("returns DATE and TIMESTAMP as strings, as the app's pg pool does", async () => {
    const db = await testDb();
    const { rows } = await db.query<{ d: unknown; ts: unknown; tz: unknown }>(
      "select date '2026-11-05' as d, timestamp '2026-11-05 01:02:03' as ts, timestamptz '2026-11-05 01:02:03Z' as tz",
    );
    expect(rows[0].d).toBe("2026-11-05");
    expect(rows[0].ts).toBe("2026-11-05 01:02:03");
    expect(rows[0].tz).toBeInstanceOf(Date);
    await db.close();
  });

  it("rolls back a transaction that throws", async () => {
    const db = await testDb();
    await db.exec("create table tx_check (id int);");
    await expect(
      db.transaction(async (tx) => {
        await tx.query("insert into tx_check values (1)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const { rows } = await db.query("select * from tx_check");
    expect(rows).toEqual([]);
    await db.close();
  });
});
