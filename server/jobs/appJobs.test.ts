import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import type { Db } from "../db/types";
import { missingRecallYears } from "../cpsc/load";
import { createShop, storeOrderLines } from "../import/store";
import { createContactCipher } from "../privacy/contactCipher";
import { appJobs, HEARTBEAT_TICKS, POLL_MS, recallPollStatus } from "./appJobs";

const fixture: Record<string, unknown>[] = JSON.parse(
  readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8"),
);
const nov5 = fixture.filter((r) => String(r.LastPublishDate).startsWith("2026-11-05"));
const NOW = new Date("2026-11-05T22:00:00Z");

/** Counts every call that would wake the database. */
function counting(db: Db) {
  const calls = { n: 0 };
  const counted: Db = {
    query: (sql, params) => {
      calls.n++;
      return db.query(sql, params);
    },
    exec: (sql) => {
      calls.n++;
      return db.exec(sql);
    },
    transaction: (fn) => {
      calls.n++;
      return db.transaction(fn);
    },
  };
  return { counted, calls };
}

function cpscAnswering(getBody: () => unknown[] | number) {
  const requested: string[] = [];
  const fetchImpl = async (url: string | URL | Request) => {
    requested.push(String(url));
    const body = getBody();
    return typeof body === "number"
      ? new Response("error", { status: body })
      : new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { requested, deps: { fetchImpl: fetchImpl as typeof fetch, sleep: async () => {}, now: () => NOW } };
}

describe("the recall poll job", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  const info: string[] = [];
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    info.length = 0;
    vi.spyOn(console, "info").mockImplementation((line: unknown) => void info.push(String(line)));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
  });

  const pulls = async () => Number((await db.query<{ n: string }>("select count(*)::text as n from cpsc_pulls")).rows[0].n);

  it("polls every 15 minutes, with a heartbeat every hour", () => {
    expect(POLL_MS).toBe(15 * 60_000);
    expect(HEARTBEAT_TICKS).toBe(4);
    const jobs = appJobs(db);
    expect(jobs.map((j) => [j.name, j.everyMs])).toEqual([["cpsc-poll", POLL_MS]]);
  });

  describe("keeping Replay fresh", () => {
    it("is asked on the hourly heartbeat, not on every poll", async () => {
      const refreshReplay = vi.fn(async () => "FRESH" as const);
      const cpsc = cpscAnswering(() => nov5);
      const [job] = appJobs(db, { ...cpsc.deps, refreshReplay });
      for (let tick = 0; tick < HEARTBEAT_TICKS + 1; tick++) await job.run();
      expect(refreshReplay).toHaveBeenCalledTimes(2);
    });

    it("reports a failed refresh without stopping the poll or calling CPSC down", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const cpsc = cpscAnswering(() => nov5);
        const [job] = appJobs(db, { ...cpsc.deps, refreshReplay: async () => Promise.reject(new Error("PayPal down")) });
        await expect(job.run()).rejects.toThrow("PayPal down");
        expect(recallPollStatus().lastPollOk).toBe(true);
        expect(await pulls()).toBeGreaterThan(0);
      } finally {
        error.mockRestore();
      }
    });
  });

  it("asks CPSC for recalls published yesterday and today", async () => {
    const cpsc = cpscAnswering(() => nov5);
    await appJobs(db, cpsc.deps)[0].run();
    const params = new URL(cpsc.requested[0]).searchParams;
    expect(params.get("LastPublishDateStart")).toBe("2026-11-04");
    expect(params.get("LastPublishDateEnd")).toBe("2026-11-05");
  });

  describe("catching up after an outage", () => {
    const recordPullRow = (rangeEnd: string, field = "LastPublishDate", status = "ok") =>
      db.query(
        `insert into cpsc_pulls (range_field, range_start, range_end, status, finished_at)
         values ($1, $2::date - 1, $2::date, $3, now())`,
        [field, rangeEnd, status],
      );
    const startOf = (url: string) => new URL(url).searchParams.get("LastPublishDateStart");

    it("reaches back to before the last good pull when it is 3 days old", async () => {
      await recordPullRow("2026-11-02");
      const cpsc = cpscAnswering(() => nov5);
      await appJobs(db, cpsc.deps)[0].run();
      expect(startOf(cpsc.requested[0])).toBe("2026-11-01");
    });

    it("counts a partial pull as covered, but ignores failed pulls and whole-year loads", async () => {
      await recordPullRow("2026-11-01", "LastPublishDate", "partial");
      await recordPullRow("2026-11-04", "LastPublishDate", "failed");
      await recordPullRow("2026-11-05", "RecallDate", "ok");
      const cpsc = cpscAnswering(() => nov5);
      await appJobs(db, cpsc.deps)[0].run();
      expect(startOf(cpsc.requested[0])).toBe("2026-10-31");
    });

    it("keeps reaching back in memory while CPSC stays down, with no database call", async () => {
      const { counted, calls } = counting(db);
      let today = new Date("2026-11-05T22:00:00Z");
      let down = false;
      const cpsc = cpscAnswering(() => (down ? 503 : nov5));
      const [poll] = appJobs(counted, { ...cpsc.deps, now: () => today });
      await poll.run(); // good: covered through Nov 5
      down = true;
      today = new Date("2026-11-08T22:00:00Z");
      calls.n = 0;
      await poll.run().catch(() => {});
      expect(calls.n).toBe(0);
      down = false;
      cpsc.requested.length = 0;
      await poll.run();
      expect(startOf(cpsc.requested[0])).toBe("2026-11-04");
    });

    it("does not move past a gap until the data is stored: a failed write keeps the catch-up point", async () => {
      await recordPullRow("2026-11-02");
      let failWrite = true;
      const flaky: Db = {
        ...db,
        transaction: (fn) => {
          if (failWrite) {
            failWrite = false;
            throw new Error("write failed");
          }
          return db.transaction(fn);
        },
      };
      const cpsc = cpscAnswering(() => nov5);
      const [poll] = appJobs(flaky, cpsc.deps);
      await expect(poll.run()).rejects.toThrow(/write failed/);
      await poll.run();
      expect(cpsc.requested.map(startOf)).toEqual(["2026-11-01", "2026-11-01"]);
      expect(Number((await db.query<{ n: string }>("select count(*)::text as n from recalls")).rows[0].n)).toBe(nov5.length);
      await poll.run(); // stored now, so the reach-back closes
      expect(startOf(cpsc.requested[2])).toBe("2026-11-04");
    });

    it("warns when the gap is older than the cap", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await recordPullRow("2026-01-01");
      await appJobs(db, cpscAnswering(() => nov5).deps)[0].run();
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
        "cpsc-poll: the last good pull ended 2026-01-01, past the 120-day catch-up cap; run pnpm load:recalls to fill the gap",
      ]);
    });
  });

  it("the first tick writes, then a quiet poll makes zero database calls", async () => {
    const { counted, calls } = counting(db);
    const cpsc = cpscAnswering(() => nov5);
    const [poll] = appJobs(counted, cpsc.deps);
    await poll.run();
    expect(calls.n).toBeGreaterThan(0);
    expect(await pulls()).toBe(1);

    calls.n = 0;
    await poll.run();
    expect(calls.n).toBe(0);
    expect(cpsc.requested).toHaveLength(2); // it still asked CPSC
    expect(await pulls()).toBe(1);
    expect(info.at(-1)).toMatch(/db=untouched/);
  });

  it("writes as soon as the snapshot changes", async () => {
    let body = nov5;
    const cpsc = cpscAnswering(() => body);
    const [poll] = appJobs(db, cpsc.deps);
    await poll.run();
    body = nov5.map((r, i) => (i === 0 ? { ...r, Title: "changed by CPSC" } : r));
    await poll.run();
    expect(await pulls()).toBe(2);
    expect(info.at(-1)).toMatch(/db=touched/);
    const { rows } = await db.query<{ n: string }>("select count(*)::text as n from recalls where title = 'changed by CPSC'");
    expect(rows[0].n).toBe("1");
  });

  it("writes on the hourly heartbeat even when nothing changed, and only then", async () => {
    const { counted, calls } = counting(db);
    const [poll] = appJobs(counted, cpscAnswering(() => nov5).deps);
    const wakes: boolean[] = [];
    for (let tick = 0; tick < HEARTBEAT_TICKS * 2 + 1; tick++) {
      calls.n = 0;
      await poll.run();
      wakes.push(calls.n > 0);
    }
    expect(wakes).toEqual([true, false, false, false, true, false, false, false, true]);
  });

  it("purges PayPal data on the heartbeat tick, and not on quiet ticks", async () => {
    const [poll] = appJobs(db, cpscAnswering(() => nov5).deps);
    const insertOld = () =>
      db.query(
        `insert into paypal_webhook_events (event_id_hmac, event_type, verification_method, received_at)
         values (gen_random_uuid()::text, 'T', 'self', $1::timestamptz - interval '3 days')`,
        [NOW.toISOString()],
      );
    const count = async () => Number((await db.query<{ n: string }>("select count(*)::text as n from paypal_webhook_events")).rows[0].n);
    await insertOld();
    await poll.run(); // heartbeat
    expect(await count()).toBe(0);
    await insertOld();
    await poll.run(); // quiet
    expect(await count()).toBe(1);
  });

  it("purges before it asks CPSC, so nothing about the response can skip or delay the purge", async () => {
    await db.query(
      `insert into paypal_webhook_events (event_id_hmac, event_type, verification_method, received_at)
       values ('old', 'T', 'self', $1::timestamptz - interval '3 days')`,
      [NOW.toISOString()],
    );
    let rowsWhenCpscAsked = -1;
    const fetchImpl = async () => {
      rowsWhenCpscAsked = (await db.query("select 1 from paypal_webhook_events")).rows.length;
      return new Response("[]", { status: 200 });
    };
    await appJobs(db, { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW })[0].run();
    expect(rowsWhenCpscAsked).toBe(0);
  });

  it("retries a failed purge on the very next tick, not an hour later, then goes quiet again", async () => {
    await db.query(
      `insert into paypal_webhook_events (event_id_hmac, event_type, verification_method, received_at)
       values ('old', 'T', 'self', $1::timestamptz - interval '3 days')`,
      [NOW.toISOString()],
    );
    let failNext = true;
    const { counted, calls } = counting({
      ...db,
      query: (sql, params) => {
        if (failNext && sql.startsWith("delete from paypal_webhook_events")) {
          failNext = false;
          throw new Error("purge stalled");
        }
        return db.query(sql, params);
      },
    } as Db);
    const [poll] = appJobs(counted, cpscAnswering(() => nov5).deps);
    await expect(poll.run()).rejects.toThrow(/purge stalled/); // heartbeat tick: the purge fails
    expect((await db.query("select 1 from paypal_webhook_events")).rows).toHaveLength(1);

    await poll.run(); // the next 15-minute tick is not a heartbeat, but the purge is still owed
    expect((await db.query("select 1 from paypal_webhook_events")).rows).toHaveLength(0);

    calls.n = 0;
    await poll.run(); // paid: this tick is quiet again
    expect(calls.n).toBe(0);
  });

  it("still purges on the heartbeat when CPSC is down, then reports the failure", async () => {
    const [poll] = appJobs(db, cpscAnswering(() => 400).deps);
    await db.query(
      `insert into paypal_webhook_events (event_id_hmac, event_type, verification_method, received_at)
       values ('old', 'T', 'self', $1::timestamptz - interval '3 days')`,
      [NOW.toISOString()],
    );
    await expect(poll.run()).rejects.toThrow(/HTTP 400/);
    expect((await db.query("select 1 from paypal_webhook_events")).rows).toEqual([]);
    const { rows } = await db.query<{ status: string }>("select status from cpsc_pulls");
    expect(rows.map((r) => r.status)).toEqual(["failed"]);
  });

  it("a CPSC failure on a quiet tick stays off the database", async () => {
    let status: number | null = null;
    const { counted, calls } = counting(db);
    const [poll] = appJobs(counted, cpscAnswering(() => status ?? nov5).deps);
    await poll.run();
    status = 400;
    calls.n = 0;
    await expect(poll.run()).rejects.toThrow(/HTTP 400/);
    expect(calls.n).toBe(0);
  });

  it("keeps the last poll time and result in memory for health, with no database call", async () => {
    const { counted, calls } = counting(db);
    let status: number | null = null;
    const [poll] = appJobs(counted, cpscAnswering(() => status ?? nov5).deps);
    await poll.run();
    calls.n = 0;
    await poll.run();
    expect(recallPollStatus()).toMatchObject({ lastPollAt: NOW.toISOString(), lastPollOk: true, dbTouched: false });
    status = 400;
    await poll.run().catch(() => {});
    expect(recallPollStatus()).toMatchObject({ lastPollOk: false });
    expect(calls.n).toBe(0);
  });

  describe("a shop that uploaded before the recall came in", () => {
    const storedShop = async () => {
      const shopId = await createShop(db, { name: "A shop", kind: "REAL" });
      await storeOrderLines(
        db,
        shopId,
        [
          {
            orderNumber: "1001",
            lineNo: 1,
            title: "Baby Brezza SuperFast Sterilizer Dryer BRZ0083",
            sku: null,
            quantity: 1,
            unitPriceCents: 5000,
            discountCents: 0,
            currency: "USD",
            orderedOn: "2026-09-15",
            paymentReference: null,
            buyerEmail: null,
          },
        ],
        createContactCipher("k".repeat(32), shopId),
        "test",
      );
      return shopId;
    };
    const matches = async (shopId: string) => (await db.query("select id from recall_matches where shop_id = $1 and verdict = 'MATCH'", [shopId])).rows;

    it("gets the recall on the tick that brings it in, and health says so", async () => {
      const shopId = await storedShop();
      const [poll] = appJobs(db, cpscAnswering(() => nov5).deps);
      await poll.run();
      expect(await matches(shopId)).toHaveLength(1);
      expect(recallPollStatus()).toMatchObject({ sweepOk: true, sweep: { shopsChecked: 1, shopsFailed: 0, shopsWaiting: 0 } });
      expect(info[0]).toContain("checked 1 shop against new recalls");
    });

    it("costs a quiet poll nothing, and keeps the last result for health", async () => {
      await storedShop();
      const { counted, calls } = counting(db);
      const [poll] = appJobs(counted, cpscAnswering(() => nov5).deps);
      await poll.run();
      calls.n = 0;
      await poll.run();
      expect(calls.n).toBe(0);
      expect(recallPollStatus()).toMatchObject({ dbTouched: false, sweep: { shopsChecked: 1 } });
    });

    it("gives a shop left waiting its turn on the next tick, not an hour later, then goes quiet", async () => {
      const first = await storedShop();
      const second = await storedShop();
      const { counted, calls } = counting(db);
      const [poll] = appJobs(counted, { ...cpscAnswering(() => nov5).deps, maxShopsPerSweep: 1 });
      await poll.run();
      expect(recallPollStatus()).toMatchObject({ sweep: { shopsChecked: 1, shopsWaiting: 1 } });
      await poll.run();
      expect(recallPollStatus()).toMatchObject({ dbTouched: true, sweep: { shopsChecked: 1, shopsWaiting: 0 } });
      expect(await matches(first)).toHaveLength(1);
      expect(await matches(second)).toHaveLength(1);
      calls.n = 0;
      await poll.run();
      expect(calls.n).toBe(0);
    });

    it("if the check can't run at all, the recall is still stored, and health and the job both say so", async () => {
      const shopId = await storedShop();
      const failing: Db = {
        ...db,
        exec: db.exec.bind(db),
        transaction: db.transaction.bind(db),
        query: ((sql: string, params?: unknown[]) => {
          if (sql.includes("recalls_checked_through")) throw new Error("no connection");
          return db.query(sql, params);
        }) as Db["query"],
      };
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const [poll] = appJobs(failing, cpscAnswering(() => nov5).deps);
      await expect(poll.run()).rejects.toThrow("no connection");
      expect(recallPollStatus()).toMatchObject({ sweepOk: false });
      expect(await pulls()).toBeGreaterThan(0);
      expect(errors.mock.calls.flat().join(" ")).toContain("no connection");
      expect(await matches(shopId)).toEqual([]);
    });
  });

  describe("loading past years that are missing", () => {
    const real: Record<string, unknown> = JSON.parse(readFileSync(new URL("../../test/fixtures/cpsc/recall_22200.json", import.meta.url), "utf8"))[0];
    /** CPSC, answering a year's question with that year's records and a poll's question with today's. */
    const cpsc = (failYear?: number) => {
      const asked: string[] = [];
      const fetchImpl = async (url: string | URL | Request) => {
        const yearAsked = /RecallDateStart=(\d{4})/.exec(String(url))?.[1];
        if (yearAsked) asked.push(yearAsked);
        if (yearAsked && Number(yearAsked) === failYear) return new Response("error", { status: 400 });
        const body = !yearAsked
          ? nov5
          : yearAsked === "2022"
            ? [real]
            : [{ ...real, RecallID: Number(yearAsked), RecallNumber: yearAsked, Title: `Other recall from ${yearAsked}`, RecallDate: `${yearAsked}-08-15T00:00:00`, LastPublishDate: `${yearAsked}-08-15T00:00:00` }];
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      };
      return { asked, deps: { fetchImpl: fetchImpl as typeof fetch, sleep: async () => {}, now: () => NOW, backfillFromYear: 2022 } };
    };
    const storedSwing = async () => {
      const shopId = await createShop(db, { name: "A shop", kind: "REAL" });
      const sale = { orderNumber: "1", lineNo: 1, title: "4moms MamaRoo Multi-Motion Swing", sku: null, quantity: 1, unitPriceCents: 8500, discountCents: 0, currency: "USD", orderedOn: "2022-05-17", paymentReference: null, buyerEmail: null };
      await storeOrderLines(db, shopId, [sale], createContactCipher("k".repeat(32), shopId), "test");
      return shopId;
    };
    const has22200 = async (shopId: string) => (await db.query("select 1 from recall_matches m join recalls r using (recall_id) where m.shop_id = $1 and r.recall_number = '22200'", [shopId])).rows.length;
    const warnings = () => vi.spyOn(console, "warn").mockImplementation(() => {});

    it("loads them on the first tick after a deploy, and a stored shop gets those recalls on that same tick", async () => {
      const shopId = await storedSwing();
      const { asked, deps } = cpsc();
      const [poll] = appJobs(db, deps);
      await poll.run();
      expect(asked).toEqual(["2022", "2023", "2024", "2025", "2026"]);
      expect(await has22200(shopId)).toBe(1);
      expect(info[0]).toContain("loaded 5 years");
    });

    it("asks nothing further once they are in, and a quiet poll still costs the database nothing", async () => {
      const { asked, deps } = cpsc();
      const { counted, calls } = counting(db);
      const [poll] = appJobs(counted, deps);
      await poll.run();
      asked.length = 0;
      calls.n = 0;
      await poll.run();
      expect(calls.n).toBe(0);
      for (let i = 1; i < HEARTBEAT_TICKS - 1; i++) await poll.run();
      await poll.run(); // the next heartbeat
      expect(asked).toEqual([]);
    });

    it("tries a failed year again on the next heartbeat, with no deploy, and the poll carries on", async () => {
      warnings();
      const first = cpsc(2023);
      const [poll] = appJobs(db, first.deps);
      await poll.run();
      expect(await missingRecallYears(db, 2022, "2026-11-05")).toEqual([2023]);

      first.asked.length = 0;
      const healed = cpsc();
      const [later] = appJobs(db, healed.deps);
      await later.run();
      expect(healed.asked).toEqual(["2023"]);
      expect(await missingRecallYears(db, 2022, "2026-11-05")).toEqual([]);
    });

    it("says which year didn't load", async () => {
      const warn = warnings();
      const [poll] = appJobs(db, cpsc(2023).deps);
      await poll.run();
      expect(warn.mock.calls.flat().join(" ")).toContain("recall year 2023 did not load");
    });

    it("says when years were left for the next hour", async () => {
      const [poll] = appJobs(db, { ...cpsc().deps, backfillBudgetMs: -1 });
      await poll.run();
      expect(info[0]).toContain("5 years left for the next hour");
    });

    it("stays out of it when not asked to load anything", async () => {
      const { asked, deps } = cpsc();
      const [poll] = appJobs(db, { ...deps, backfillFromYear: undefined });
      await poll.run();
      expect(asked).toEqual([]);
    });
  });

  it("logs exactly one line per tick saying whether the database was touched", async () => {
    const [poll] = appJobs(db, cpscAnswering(() => nov5).deps);
    await poll.run();
    await poll.run();
    expect(info).toHaveLength(2);
    expect(info[0]).toMatch(/^cpsc-poll 2026-11-04\.\.2026-11-05: fetched \d+, db=touched \(heartbeat\), .*purged \{/);
    expect(info[1]).toMatch(/^cpsc-poll 2026-11-04\.\.2026-11-05: fetched \d+, db=untouched$/);
  });
});
