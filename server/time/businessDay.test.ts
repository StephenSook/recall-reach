import { describe, expect, it } from "vitest";
import { businessDay } from "./businessDay";

describe("businessDay", () => {
  it.each([
    ["an evening in Eastern Standard Time is still that day", "2026-11-06T01:15:00Z", "2026-11-05"],
    ["the last minute of the day", "2026-11-06T04:59:00Z", "2026-11-05"],
    ["the first minute of the next", "2026-11-06T05:00:00Z", "2026-11-06"],
    ["summer time moves the rollover an hour", "2026-07-01T03:59:00Z", "2026-06-30"],
    ["and past it", "2026-07-01T04:00:00Z", "2026-07-01"],
  ])("%s", (_name, at, day) => {
    expect(businessDay(new Date(at))).toBe(day);
  });
});
