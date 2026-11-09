import { describe, expect, it } from "vitest";
import { checkNewman } from "./newman-floor";

const good = () => ({
  run: {
    stats: {
      requests: { total: 10, failed: 0 },
      assertions: { total: 26, failed: 0 },
    },
    executions: Array.from({ length: 10 }, () => ({})),
  },
});

describe("checkNewman", () => {
  it("passes when all 10 requests and 26 assertions ran without failures", () => {
    expect(checkNewman(good())).toEqual({ ok: true, reasons: [] });
  });

  it("passes when more requests and assertions ran", () => {
    const report = good();
    report.run.stats.requests.total = 11;
    report.run.stats.assertions.total = 30;
    report.run.executions.push({});
    expect(checkNewman(report)).toEqual({ ok: true, reasons: [] });
  });

  it.each([
    ["fewer than 10 requests", "requests", "total", 9, "run.stats.requests.total must be at least 10"],
    ["fewer than 26 assertions", "assertions", "total", 25, "run.stats.assertions.total must be at least 26"],
    ["one failed assertion", "assertions", "failed", 1, "run.stats.assertions.failed must be 0"],
    ["one failed request", "requests", "failed", 1, "run.stats.requests.failed must be 0"],
  ] as const)("fails on %s", (_name, stat, count, value, reason) => {
    const report = good();
    report.run.stats[stat][count] = value;
    const result = checkNewman(report);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContainEqual(expect.stringContaining(reason));
  });

  it.each([
    ["missing stats", { run: { executions: good().run.executions } }, "run.stats.requests.total is missing"],
    ["an empty object", {}, "run.stats.assertions.total is missing"],
    ["a non-object", null, "run.stats.requests.total is missing"],
    ["a string", "not a report", "run.stats.requests.total is missing"],
    ["an array", [], "run.stats.requests.total is missing"],
    ["missing executions", { run: { stats: good().run.stats } }, "run.executions.length is missing"],
    ["too few executions", { run: { stats: good().run.stats, executions: [] } }, "run.executions.length must be at least 10"],
  ])("fails on %s", (_name, report, reason) => {
    const result = checkNewman(report);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContainEqual(expect.stringContaining(reason));
  });

  it.each(["requests", "assertions"] as const)("fails when either %s count is missing or invalid", (stat) => {
    for (const count of ["total", "failed"] as const) {
      for (const value of [undefined, null, "0", -1, 0.5, NaN, Infinity]) {
        const report = good();
        const counts: Record<string, unknown> = report.run.stats[stat];
        counts[count] = value;
        const result = checkNewman(report);
        expect(result.ok).toBe(false);
        expect(result.reasons).toContainEqual(expect.stringContaining(`run.stats.${stat}.${count} is missing or invalid`));
      }
    }
  });
});
