import { describe, expect, it } from "vitest";
import { GET } from "./route";

const get = (platform: string) => GET(new Request(`https://example.test/get/${platform}`), { params: Promise.resolve({ platform }) });

describe("stable addresses for the phone builds", () => {
  it.each([
    ["ios", "https://testflight.apple.com/join/2AGeG7KY"],
    ["android", "https://github.com/StephenSook/recall-reach/releases/download/android-1.0.0/recall-reach-android-1.0.0.apk"],
  ])("sends /get/%s straight to its build, with a plain 302", async (platform, target) => {
    const res = await get(platform);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(target);
  });

  it("adds no tracking to the address and sets no cookie", async () => {
    const res = await get("ios");
    expect(new URL(res.headers.get("location")!).search).toBe("");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it.each(["windows", "IOS", "constructor", "__proto__", ""])("answers 404 for %j", async (platform) => {
    const res = await get(platform);
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });
});
