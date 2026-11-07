import { describe, expect, it, vi } from "vitest";
import { waitForBuild } from "./expectBuild";

const health = (build: string | null) => async () => Response.json({ build });
const noSleep = async () => {};

describe("waiting for the deployed build before a deployed test runs", () => {
  it("goes ahead once /api/health names the build that should be live", async () => {
    const fetchImpl = vi.fn().mockImplementationOnce(health("0291ba4")).mockImplementationOnce(health("7f9a896"));
    await expect(waitForBuild({ base: "https://example.test", want: "7f9a896", fetchImpl, sleep: noSleep, tries: 5 })).resolves.toBe(2);
    expect(fetchImpl).toHaveBeenCalledWith("https://example.test/api/health", expect.anything());
  });

  it("fails, naming both builds, if the new one never answers, so the old one can't pass for it", async () => {
    await expect(waitForBuild({ base: "https://example.test", want: "7f9a896", fetchImpl: vi.fn(health("0291ba4")), sleep: noSleep, tries: 3 })).rejects.toThrow(/7f9a896.*0291ba4/);
  });

  it("refuses to run against a deployed site without being told which build to expect", async () => {
    await expect(waitForBuild({ base: "https://example.test", want: undefined, fetchImpl: vi.fn(), sleep: noSleep, tries: 3 })).rejects.toThrow(/EXPECT_BUILD/);
  });

  it("asks nothing of a local server", async () => {
    const fetchImpl = vi.fn();
    await expect(waitForBuild({ base: "http://localhost:3000", want: undefined, fetchImpl, sleep: noSleep, tries: 3 })).resolves.toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps waiting through a deploy's failed answers", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockImplementationOnce(async () => new Response("bad gateway", { status: 502 })).mockImplementationOnce(health("7f9a896"));
    await expect(waitForBuild({ base: "https://example.test", want: "7f9a896", fetchImpl, sleep: noSleep, tries: 5 })).resolves.toBe(3);
  });
});
