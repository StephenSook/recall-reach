import { describe, expect, it, vi } from "vitest";
import { latestReadLine } from "./latestRead";

const NOW = new Date("2026-11-07T15:00:00.000Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const poll = (over: Partial<{ lastPollAt: string | null; lastPollOk: boolean | null }> = {}) => ({ lastPollAt: ago(10), lastPollOk: true, dbTouched: false, ...over });

describe("the line on the home page about CPSC", () => {
  it("gives the latest read and how many recalls are held", async () => {
    const count = vi.fn(async () => 1855);
    expect(await latestReadLine(poll(), count, NOW)).toBe("Latest CPSC read Nov 7, 2026, 9:50 AM ET. 1,855 recalls since 2022.");
  });

  it.each([
    ["the last read failed", poll({ lastPollOk: false })],
    ["nothing has been read since this started", poll({ lastPollAt: null, lastPollOk: null })],
    ["the last read is over 2.5 hours old", poll({ lastPollAt: ago(151) })],
  ])("leaves it out when %s", async (_name, status) => {
    expect(await latestReadLine(status, vi.fn(async () => 1855), NOW)).toBeNull();
  });

  it("leaves it out when the count can't be read or is empty, and doesn't throw", async () => {
    expect(await latestReadLine(poll(), vi.fn(async () => Promise.reject(new Error("down"))), NOW)).toBeNull();
    expect(await latestReadLine(poll(), vi.fn(async () => 0), NOW)).toBeNull();
  });
});
