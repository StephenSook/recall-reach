import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cpscPollRange, MAX_CATCHUP_DAYS, startScheduler } from "./scheduler";

describe("startScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs each job once at start and then on its interval", async () => {
    const runs: string[] = [];
    const stop = startScheduler(
      [
        { name: "a", everyMs: 1000, run: async () => void runs.push("a") },
        { name: "b", everyMs: 3000, run: async () => void runs.push("b") },
      ],
      { log: () => {} },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(runs.filter((r) => r === "a")).toHaveLength(4);
    expect(runs.filter((r) => r === "b")).toHaveLength(2);
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runs.filter((r) => r === "a")).toHaveLength(4);
  });

  it("skips a tick while the previous run of the same job is still going", async () => {
    let started = 0;
    let release: () => void = () => {};
    const stop = startScheduler(
      [
        {
          name: "slow",
          everyMs: 1000,
          deadlineMs: 60_000,
          run: () => {
            started++;
            return new Promise<void>((resolve) => (release = resolve));
          },
        },
      ],
      { log: () => {} },
    );
    await vi.advanceTimersByTimeAsync(3500);
    expect(started).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(started).toBe(2);
    stop();
  });

  it("logs a failed run and keeps the schedule going", async () => {
    const logs: string[] = [];
    let calls = 0;
    const stop = startScheduler(
      [
        {
          name: "flaky",
          everyMs: 1000,
          run: async () => {
            calls++;
            if (calls === 1) throw new Error("CPSC returned HTTP 503");
          },
        },
      ],
      { log: (line) => logs.push(line) },
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
    expect(logs).toEqual(["job flaky failed: CPSC returned HTTP 503"]);
    stop();
  });
});

describe("job deadlines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("releases a stalled run at its deadline, logs it, and lets the next tick run", async () => {
    const logs: string[] = [];
    let started = 0;
    const stop = startScheduler(
      [{ name: "stuck", everyMs: 1000, deadlineMs: 2500, run: () => (started++, new Promise<void>(() => {})) }],
      { log: (line) => logs.push(line) },
    );
    await vi.advanceTimersByTimeAsync(2400);
    expect(started).toBe(1);
    await vi.advanceTimersByTimeAsync(700); // past the 2500 ms deadline, and tick 3000 fires
    expect(logs).toContain("job stuck exceeded its 2500 ms deadline; released");
    expect(started).toBe(2);
    stop();
  });

  it("logs once when ticks are being skipped behind a long run", async () => {
    const logs: string[] = [];
    const stop = startScheduler(
      [{ name: "slow", everyMs: 1000, deadlineMs: 60_000, run: () => new Promise<void>(() => {}) }],
      { log: (line) => logs.push(line) },
    );
    await vi.advanceTimersByTimeAsync(5500);
    expect(logs.filter((l) => l.includes("skipping ticks"))).toEqual(["job slow still running after 2 s; skipping ticks"]);
    stop();
  });

  it("a stalled run finishing late does not release the run that replaced it", async () => {
    let finishFirst: () => void = () => {};
    let started = 0;
    const stop = startScheduler(
      [
        {
          name: "late",
          everyMs: 1000,
          deadlineMs: 1500,
          run: () => {
            started++;
            return started === 1 ? new Promise<void>((resolve) => (finishFirst = resolve)) : new Promise<void>(() => {});
          },
        },
      ],
      { log: () => {} },
    );
    await vi.advanceTimersByTimeAsync(2100); // first run released at 1500, second started at 2000
    expect(started).toBe(2);
    finishFirst();
    await vi.advanceTimersByTimeAsync(1000); // second is still inside its deadline: this tick must skip
    expect(started).toBe(2);
    stop();
  });
});

describe("cpscPollRange", () => {
  const NOW = new Date("2026-11-06T02:30:00Z");

  it("asks for recalls published or republished yesterday and today (UTC days)", () => {
    expect(cpscPollRange(NOW)).toEqual({ field: "LastPublishDate", start: "2026-11-05", end: "2026-11-06" });
  });

  it("reaches back to one day before the last pull that succeeded", () => {
    expect(cpscPollRange(NOW, "2026-11-03").start).toBe("2026-11-02");
  });

  it("never starts later than yesterday, however recent the last pull", () => {
    expect(cpscPollRange(NOW, "2026-11-06").start).toBe("2026-11-05");
  });

  it("caps how far back it reaches", () => {
    expect(MAX_CATCHUP_DAYS).toBe(120);
    expect(cpscPollRange(NOW, "2026-01-01").start).toBe("2026-07-09");
  });
});
