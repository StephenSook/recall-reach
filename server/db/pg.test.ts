import { EventEmitter } from "node:events";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BILLING_POOL_MAX, closeDb, getBillingDb, getDb, POOL_CONFIG } from "./pg";

// Exercise the real pg.Pool checkout queue without opening a socket.
class LocalClient extends EventEmitter {
  _queryable = true;
  _ending = false;
  connect(callback: () => void) { queueMicrotask(callback); }
  query(_sql: string, _params?: unknown[], callback?: (err: null, result: { rows: { one: number }[] }) => void) {
    const result = { rows: [{ one: 1 }] };
    if (callback) queueMicrotask(() => callback(null, result));
    else return Promise.resolve(result);
  }
  end(callback?: () => void) {
    this._ending = true;
    queueMicrotask(() => { this.emit("end"); callback?.(); });
  }
}

describe("POOL_CONFIG", () => {
  it("bounds every query on the client", () => {
    expect(POOL_CONFIG.query_timeout).toBeGreaterThan(0);
    expect(POOL_CONFIG.keepAlive).toBe(true);
  });

  it("lets idle connections go quickly so they never hold the Neon compute awake", () => {
    expect(POOL_CONFIG.idleTimeoutMillis).toBeLessThanOrEqual(10_000);
    expect(POOL_CONFIG.min ?? 0).toBe(0);
  });
});

describe.each([getDb, getBillingDb])("%s", (getDatabase) => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeDb();
    vi.restoreAllMocks();
  });

  it("refuses to start without DATABASE_URL", () => {
    vi.stubEnv("DATABASE_URL", "");
    expect(() => getDatabase()).toThrow(/DATABASE_URL is not set/);
  });

  it("refuses a DATABASE_URL that is not a postgres URL", () => {
    vi.stubEnv("DATABASE_URL", "mysql://user:pw@localhost/db");
    expect(() => getDatabase()).toThrow(/postgres/);
  });

  it("returns the same pool on every call", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pw@localhost:5432/db");
    expect(getDatabase()).toBe(getDatabase());
  });
});

describe("billing pool isolation", () => {
  afterEach(async () => {
    await closeDb();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("serves a safety query while both billing clients are held by stalled work", async () => {
    const url = "postgresql://user:pw@localhost:5432/db";
    vi.stubEnv("DATABASE_URL", url);
    const Pool = pg.Pool;
    const pools: pg.Pool[] = [];
    const factory = vi.spyOn(pg, "Pool").mockImplementation(function (config) {
      const pool = new Pool({ ...config, Client: LocalClient } as unknown as pg.PoolConfig);
      pools.push(pool);
      return pool;
    });
    const safety = getDb();
    const billing = getBillingDb();
    expect(billing).not.toBe(safety);
    expect(getBillingDb()).toBe(billing);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory.mock.calls[0][0]).toMatchObject({ ...POOL_CONFIG, connectionString: url });
    expect(factory.mock.calls[1][0]).toMatchObject({ ...POOL_CONFIG, connectionString: url, max: BILLING_POOL_MAX });
    expect(BILLING_POOL_MAX).toBe(2);

    let release!: () => void;
    const stalled = new Promise<void>((resolve) => { release = resolve; });
    const entered: Promise<void>[] = [];
    const held = Array.from({ length: BILLING_POOL_MAX }, () => {
      let started!: () => void;
      entered.push(new Promise<void>((resolve) => { started = resolve; }));
      return billing.transaction(async () => {
        started();
        await stalled; // No result until teardown releases the work.
      });
    });
    let queued: Promise<unknown> | undefined;
    try {
      await Promise.all(entered);
      expect(pools[1].totalCount).toBe(2);
      expect(pools[1].idleCount).toBe(0);
      const finished = vi.fn();
      queued = billing.query("select 1 as one").then(finished);
      expect(pools[1].waitingCount).toBe(1);
      await expect(safety.query("select 1 as one")).resolves.toEqual({ rows: [{ one: 1 }] });
      expect(finished).not.toHaveBeenCalled();
      expect(pools[1].waitingCount).toBe(1);
    } finally {
      release();
      await Promise.all([...held, queued]);
    }
  }, 5000);
});
