import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/pg", () => ({ getDb: () => ({}) }));
const load = vi.hoisted(() => vi.fn());
vi.mock("@/server/import/ownFile", async (original) => ({ ...(await original<typeof import("@/server/import/ownFile")>()), importOwnFile: load }));

import { MAX_FILE_BYTES, OwnFileRefused } from "@/server/import/ownFile";
import { POST } from "./route";

const post = (over: { file?: string | null; origin?: string; ip?: string; name?: string } = {}) => {
  const body = new FormData();
  body.set("shopName", over.name ?? "Little Sprouts");
  if (over.file !== null) body.set("file", new File([over.file ?? "order_number,title"], "orders.csv", { type: "text/csv" }));
  return POST(new Request("http://localhost/api/shop/import", { method: "POST", headers: { origin: over.origin ?? "http://localhost", "true-client-ip": over.ip ?? `203.0.113.${Math.floor(Math.random() * 250)}` }, body }));
};

describe("POST /api/shop/import", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "s".repeat(32));
    vi.stubEnv("SHOP_DATA_KEY", "k".repeat(32));
    vi.spyOn(console, "error").mockImplementation(() => {});
    load.mockReset();
    load.mockResolvedValue({ shopId: "00000000-0000-4000-8000-000000000001", lines: 3, rejected: 0 });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("refuses a post from another site before reading anything", async () => {
    expect((await post({ origin: "https://elsewhere.example" })).status).toBe(403);
    expect(load).not.toHaveBeenCalled();
  });

  it("signs the shop in and goes to its queue", async () => {
    const res = await post();
    expect(res.headers.get("location")).toBe("http://localhost/queue");
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/);
    expect(load).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ shopName: "Little Sprouts", csv: "order_number,title" }));
  });

  it("says how many rows it could not read", async () => {
    load.mockResolvedValue({ shopId: "00000000-0000-4000-8000-000000000001", lines: 3, rejected: 2 });
    const url = new URL((await post()).headers.get("location") ?? "");
    expect(url.pathname).toBe("/queue");
    expect(url.searchParams.get("message")).toBe("Read 3 lines. 2 rows could not be read.");
  });

  it.each(["NO_NAME", "NOT_READABLE", "EMPTY", "TOO_MANY"] as const)("sends %s back to the form, signed in as no one", async (code) => {
    load.mockRejectedValue(new OwnFileRefused(code));
    const res = await post();
    expect(res.headers.get("location")).toBe(`http://localhost/check?error=${code}`);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("says so when no file came", async () => {
    expect((await post({ file: null })).headers.get("location")).toBe("http://localhost/check?error=NOT_READABLE");
  });

  it("refuses a file over the limit without reading it", async () => {
    const res = await post({ file: "x".repeat(MAX_FILE_BYTES + 100_000) });
    expect(res.headers.get("location")).toBe("http://localhost/check?error=TOO_BIG");
    expect(load).not.toHaveBeenCalled();
  });

  it("limits one visitor", async () => {
    let last = await post({ ip: "198.51.100.7" });
    for (let i = 0; i < 5; i++) last = await post({ ip: "198.51.100.7" });
    expect(last.headers.get("location")).toBe("http://localhost/check?error=BUSY");
  });

  it("does not say why anything else failed", async () => {
    load.mockRejectedValue(new Error("database detail"));
    const res = await post();
    expect(res.headers.get("location")).toBe("http://localhost/check?error=FAILED");
  });
});
