import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/pg", () => ({ getDb: () => ({}) }));
const load = vi.hoisted(() => vi.fn());
vi.mock("@/server/import/storeListings", () => ({ importStoreListings: load }));
const loadFile = vi.hoisted(() => vi.fn());
vi.mock("@/server/import/ownFile", async (original) => ({ ...(await original<typeof import("@/server/import/ownFile")>()), importOwnFile: loadFile }));

import { OWN_FILE_DAYS } from "@/server/import/ownFile";
import { StoreFeedRefused } from "@/server/import/storeFeed";
import { POST as postFile } from "../import/route";
import { POST } from "./route";

let next = 1;
const freshIp = () => `198.51.100.${next++}`;
const post = (over: { address?: string; origin?: string; ip?: string; body?: string } = {}) =>
  POST(
    new Request("http://localhost/api/shop/listings", {
      method: "POST",
      headers: { origin: over.origin ?? "http://localhost", "true-client-ip": over.ip ?? freshIp(), "content-type": "application/x-www-form-urlencoded" },
      body: over.body ?? new URLSearchParams({ address: over.address ?? `store-number-${next++}.com` }).toString(),
    }),
  );

describe("POST /api/shop/listings", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "s".repeat(32));
    vi.stubEnv("SHOP_DATA_KEY", "k".repeat(32));
    load.mockReset();
    load.mockResolvedValue({ shopId: "00000000-0000-4000-8000-000000000001", listings: 219, complete: true });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("refuses a post from another site before reading anything", async () => {
    expect((await post({ origin: "https://elsewhere.example" })).status).toBe(403);
    expect(load).not.toHaveBeenCalled();
  });

  it("signs the shop in for as long as its data is kept, and goes to its queue", async () => {
    const res = await post({ address: "mystore.com" });
    expect(res.headers.get("location")).toBe("http://localhost/queue");
    expect(res.headers.get("set-cookie")).toContain(`Max-Age=${OWN_FILE_DAYS * 86_400}`);
    expect(load).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ typed: "mystore.com" }));
  });

  it("says so when it read only part of the store, and puts no store name in the address", async () => {
    load.mockResolvedValue({ shopId: "00000000-0000-4000-8000-000000000001", listings: 1000, complete: false });
    const location = (await post({ address: "mystore.com" })).headers.get("location") ?? "";
    expect(new URL(location).searchParams.get("message")).toBe("Read the first 1,000 listings. The rest weren't checked.");
    expect(location).not.toContain("mystore");
  });

  it.each(["127.0.0.1", "localhost", "http://mystore.com", "https://user:pw@mystore.com", "mystore.com:8443", "169.254.169.254", ""])("sends %j back before any network, signed in as no one", async (address) => {
    const res = await post({ address });
    expect(res.headers.get("location")).toBe("http://localhost/check?error=BAD_ADDRESS");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("doesn't charge a typing slip against the visitor's checks", async () => {
    const ip = freshIp();
    for (let i = 0; i < 8; i++) await post({ ip, address: "not an address" });
    expect((await post({ ip })).headers.get("location")).toBe("http://localhost/queue");
  });

  it("refuses a body far too long to be an address, without reading it", async () => {
    const res = await post({ body: `address=${"x".repeat(3000)}` });
    expect(res.headers.get("location")).toBe("http://localhost/check?error=BAD_ADDRESS");
    expect(load).not.toHaveBeenCalled();
  });

  it.each(["CANT_REACH", "NO_FEED", "ROBOTS", "MOVED", "EMPTY_FEED"] as const)("sends %s back to the form, signed in as no one", async (code) => {
    load.mockRejectedValue(new StoreFeedRefused(code));
    const res = await post();
    expect(res.headers.get("location")).toBe(`http://localhost/check?error=${code}`);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("limits one visitor", async () => {
    const ip = freshIp();
    let last = await post({ ip, address: "a-store.com" });
    for (let i = 0; i < 5; i++) last = await post({ ip, address: `store-${i}.com` });
    expect(last.headers.get("location")).toBe("http://localhost/check?error=BUSY");
  });

  it("counts a file and a store address against the same limit", async () => {
    loadFile.mockResolvedValue({ shopId: "00000000-0000-4000-8000-000000000001", lines: 1, rejected: 0 });
    const ip = freshIp();
    for (let i = 0; i < 5; i++) {
      const body = new FormData();
      body.set("shopName", "Shop");
      body.set("file", new File(["order_number,title"], "orders.csv", { type: "text/csv" }));
      await postFile(new Request("http://localhost/api/shop/import", { method: "POST", headers: { origin: "http://localhost", "true-client-ip": ip }, body }));
    }
    expect((await post({ ip, address: "another-store.com" })).headers.get("location")).toBe("http://localhost/check?error=BUSY");
  });

  it("won't read one store more than six times an hour, however many visitors ask", async () => {
    const answers: (string | null)[] = [];
    for (let i = 0; i < 7; i++) answers.push((await post({ address: "popular-store.com" })).headers.get("location"));
    expect(answers.slice(0, 6).every((a) => a === "http://localhost/queue")).toBe(true);
    expect(answers[6]).toBe("http://localhost/check?error=BUSY");
    expect(load).toHaveBeenCalledTimes(6);
  });

  it("puts neither the store's name nor the error's words in a log", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    load.mockRejectedValue(new TypeError("failed on mystore.com"));
    const res = await post({ address: "mystore.com" });
    expect(res.headers.get("location")).toBe("http://localhost/check?error=FAILED");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("mystore");
  });
});
