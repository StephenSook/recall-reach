import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/test/pglite";
import { pullRecalls } from "@/server/cpsc/pull";
import { migrate } from "@/server/db/migrate";
import type { Queryable } from "@/server/db/types";
import { readPublicRecall } from "@/server/match/textCheck";

let db: Queryable;
vi.mock("@/server/db/pg", () => ({ getDb: () => db }));

import { GET } from "./route";
import { GET as check } from "../../check/route";
import { GET as todayMatches } from "../today/matches/route";

const fixtureText = readFileSync(new URL("../../../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
let visitor = 0;
const read = (recallNumber: string, ip = `198.51.100.${visitor++ % 250}`) =>
  GET(new Request(`http://localhost/api/recalls/${encodeURIComponent(recallNumber)}`, { headers: { "true-client-ip": ip } }), { params: Promise.resolve({ recallNumber }) });

const publicHeaders = (res: Response) => {
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
  expect(res.headers.get("set-cookie")).toBeNull();
};

describe("GET /api/recalls/{recallNumber}", () => {
  let real: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    real = await testDb();
    await migrate(real);
    db = real;
    const fetchImpl = async () => new Response(fixtureText, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(real, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await real.close();
  });

  it("returns exactly the public record get_recall reads, with no sign-in", async () => {
    const query = vi.spyOn(real, "query");
    const res = await read("27072");
    expect(res.status).toBe(200);
    publicHeaders(res);
    const body = await res.json();
    expect(body).toMatchObject({ found: true, recallNumber: "27072", title: expect.stringContaining("Baby Brezza") });
    expect(Object.keys(body).sort()).toEqual(["description", "found", "hazards", "image", "products", "recallDate", "recallNumber", "remedies", "title", "url"]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(/^select .* from recalls where /);
    // The same function the MCP get_recall handler calls, without an HTTP request to MCP.
    expect(body).toEqual(await readPublicRecall(real, "27072"));
  });

  it.each(["27072' or 1=1", "not a number", "a".repeat(17), "27072/extra", "27072\n"])("refuses a malformed number before any query: %s", async (number) => {
    const query = vi.spyOn(real, "query");
    const res = await read(number);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "that isn't a recall number" });
    expect(query).not.toHaveBeenCalled();
    publicHeaders(res);
  });

  it("answers 404 for a number it does not hold", async () => {
    const res = await read("99999");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no such recall is held here" });
    publicHeaders(res);
  });

  it("shares /api/check's visitor limit and its too many checks answer", async () => {
    const ip = "203.0.113.201";
    const checked = await check(new Request("http://localhost/api/check?title=chair", { headers: { "true-client-ip": ip } }));
    expect(checked.status).toBe(200);
    for (let i = 0; i < 59; i++) expect((await read("27072", ip)).status).toBe(200);
    const query = vi.spyOn(real, "query");
    const res = await read("27072", ip);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "too many checks: try again in an hour" });
    expect(res.headers.get("retry-after")).toBe("3600");
    expect(query).not.toHaveBeenCalled();
    publicHeaders(res);
  });

  it("doesn't repeat the input or a database error's text when the read fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    db = {
      query: async () => { throw new Error("failed on SECRET-NUMBER"); },
      exec: async () => {},
    };
    const res = await read("SECRET-NUMBER");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "the recall could not be read just now" });
    expect(JSON.stringify(logged.mock.calls)).not.toContain("SECRET-NUMBER");
    publicHeaders(res);
  });

  it("leaves GET /api/recalls/today/matches restricted to the demo shop and reporting no replay", async () => {
    const privateShop = await todayMatches(new Request("http://localhost/api/recalls/today/matches?shop=other"));
    expect(privateShop.status).toBe(400);
    expect(await privateShop.json()).toEqual({ error: "only shop=demo is public" });
    const demo = await todayMatches(new Request("http://localhost/api/recalls/today/matches?shop=demo"));
    expect(demo.status).toBe(404);
    expect(await demo.json()).toEqual({ error: "no Recall Replay has run yet: press Run it on /replay" });
  });
});
