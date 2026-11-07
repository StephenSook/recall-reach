import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fetchRecalls, recallsUrl } from "./fetch";

const fixtureText = readFileSync(
  new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url),
  "utf8",
);
const FIXTURE_RANGE = { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" } as const;

type Reply = Response | Error;

/** A fetch stand-in that records requested URLs and plays back replies in order. */
function scripted(replies: Reply[]) {
  const urls: string[] = [];
  const sleeps: number[] = [];
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    urls.push(String(input));
    const next = replies.shift();
    if (!next) throw new Error("no scripted reply left");
    if (next instanceof Error) throw next;
    return next;
  };
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return { urls, sleeps, deps: { fetchImpl: fetchImpl as typeof fetch, sleep } };
}

const json = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json; charset=utf-8" } });

describe("recallsUrl", () => {
  it("asks for JSON with RecallDate range parameters", () => {
    const url = new URL(recallsUrl(FIXTURE_RANGE));
    expect(url.origin + url.pathname).toBe("https://www.saferproducts.gov/RestWebServices/Recall");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      format: "json",
      RecallDateStart: "2026-10-01",
      RecallDateEnd: "2026-11-05",
    });
  });

  it("uses LastPublishDate range parameters for the LastPublishDate field", () => {
    const url = new URL(recallsUrl({ field: "LastPublishDate", start: "2026-11-04", end: "2026-11-05" }));
    expect(url.searchParams.get("LastPublishDateStart")).toBe("2026-11-04");
    expect(url.searchParams.get("LastPublishDateEnd")).toBe("2026-11-05");
    expect(url.searchParams.has("RecallDateStart")).toBe(false);
  });

  it("rejects a range that ends before it starts", () => {
    expect(() => recallsUrl({ field: "RecallDate", start: "2026-11-05", end: "2026-11-01" })).toThrow(/before/);
  });

  it("rejects a date that is not YYYY-MM-DD", () => {
    expect(() => recallsUrl({ field: "RecallDate", start: "2026-1-5", end: "2026-11-05" })).toThrow(/YYYY-MM-DD/);
  });
});

describe("fetchRecalls", () => {
  it("returns every record when CPSC answers a JSON array inside the range", async () => {
    const s = scripted([json(fixtureText)]);
    const records = await fetchRecalls(FIXTURE_RANGE, s.deps);
    expect(records).toHaveLength(55);
    expect(s.urls).toEqual([recallsUrl(FIXTURE_RANGE)]);
  });

  it("refuses an HTML page served with HTTP 200 and says it may be a challenge page", async () => {
    const s = scripted([new Response("<html><body>Request unsuccessful</body></html>", { status: 200 })]);
    await expect(fetchRecalls(FIXTURE_RANGE, s.deps)).rejects.toThrow(/not a JSON array[\s\S]*challenge/);
  });

  it("refuses records outside the requested range (the filter was ignored)", async () => {
    const s = scripted([json(fixtureText)]);
    const oneDay = { field: "RecallDate", start: "2026-11-05", end: "2026-11-05" } as const;
    await expect(fetchRecalls(oneDay, s.deps)).rejects.toThrow(/outside the requested range/);
  });

  describe("when CPSC reports its own failure with HTTP 200", () => {
    // Measured 2026-11-07: one row, RecallID 0, nulls throughout, and the error in Title.
    const errorRow = { RecallID: 0, RecallNumber: null, RecallDate: null, LastPublishDate: null, Title: "Error retrieving Recalls: The underlying provider failed on Open." };
    const range = { field: "LastPublishDate", start: "2026-11-06", end: "2026-11-07" } as const;

    it("is a failed fetch, tried again, and never data", async () => {
      let calls = 0;
      const fetchImpl = (async () => {
        calls++;
        return new Response(JSON.stringify([errorRow]), { status: 200 });
      }) as typeof fetch;
      await expect(fetchRecalls(range, { fetchImpl, sleep: async () => {} })).rejects.toThrow(/CPSC reported an error: "Error retrieving Recalls/);
      expect(calls).toBeGreaterThan(1);
    });

    it("recovers if the next try answers", async () => {
      const answers = [[errorRow], []];
      const fetchImpl = (async () => new Response(JSON.stringify(answers.shift()), { status: 200 })) as typeof fetch;
      expect(await fetchRecalls(range, { fetchImpl, sleep: async () => {} })).toEqual([]);
    });

    it("still takes an empty answer as no recalls", async () => {
      const fetchImpl = (async () => new Response("[]", { status: 200 })) as typeof fetch;
      expect(await fetchRecalls(range, { fetchImpl, sleep: async () => {} })).toEqual([]);
    });

    it("leaves a real record with a bad field for the schema to report", async () => {
      const row = { RecallID: 99, RecallNumber: null, LastPublishDate: "2026-11-06T00:00:00", Title: "A real recall" };
      const fetchImpl = (async () => new Response(JSON.stringify([row]), { status: 200 })) as typeof fetch;
      expect(await fetchRecalls(range, { fetchImpl, sleep: async () => {} })).toEqual([row]);
    });
  });

  it("retries a 503 and returns the next good answer", async () => {
    const s = scripted([new Response("busy", { status: 503 }), json(fixtureText)]);
    const records = await fetchRecalls(FIXTURE_RANGE, s.deps);
    expect(records).toHaveLength(55);
    expect(s.urls).toHaveLength(2);
    expect(s.sleeps).toEqual([1000]);
  });

  it("retries a network error and returns the next good answer", async () => {
    const s = scripted([new TypeError("fetch failed"), json(fixtureText)]);
    expect(await fetchRecalls(FIXTURE_RANGE, s.deps)).toHaveLength(55);
  });

  it("gives up after three attempts and reports the last status", async () => {
    const s = scripted([503, 502, 500].map((status) => new Response("down", { status })));
    await expect(fetchRecalls(FIXTURE_RANGE, s.deps)).rejects.toThrow(/HTTP 500 after 3 attempts/);
    expect(s.sleeps).toEqual([1000, 2000]);
  });

  it("does not retry a 400", async () => {
    const s = scripted([new Response("bad request", { status: 400 }), json(fixtureText)]);
    await expect(fetchRecalls(FIXTURE_RANGE, s.deps)).rejects.toThrow(/HTTP 400/);
    expect(s.urls).toHaveLength(1);
  });
});
