import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cpscPollRange, startScheduler } from "./scheduler";

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

describe("cpscPollRange", () => {
  it("asks for recalls published or republished yesterday and today (UTC days)", () => {
    expect(cpscPollRange(new Date("2026-11-06T02:30:00Z"))).toEqual({
      field: "LastPublishDate",
      start: "2026-11-05",
      end: "2026-11-06",
    });
  });
});
