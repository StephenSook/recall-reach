// openapi.yaml is a claim about the running code, so it is checked against it: the file is valid, every path it documents
// exists, every public GET is documented, and the answers the code really gives have the shape it describes.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { Validator } from "@seriousme/openapi-schema-validator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { answerSearch } from "../test/fakeHistory";
import { testDb } from "../test/pglite";
import { pullRecalls } from "./cpsc/pull";
import { migrate } from "./db/migrate";
import { getHealth } from "./health";
import { checkText } from "./match/textCheck";
import type { Method, PayPalClient } from "./paypal/client";
import { latestRecallDay, loadReplay, proveReplay, runReplay } from "./replay/replay";

type Schema = { $ref?: string; type?: string; required?: string[]; properties?: Record<string, Schema>; items?: Schema; nullable?: boolean; enum?: unknown[] };

const spec = parse(readFileSync("openapi.yaml", "utf8")) as {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, Schema> };
};

const routeFile = (path: string) => `app${path.replace(/\{(\w+)\}/g, "[$1]")}/route.ts`;

/** What the code's answer gets wrong against the documented shape. Empty means it fits. */
function misfits(schema: Schema, value: unknown, at = "answer"): string[] {
  if (schema.$ref) return misfits(spec.components.schemas[schema.$ref.split("/").pop() ?? ""], value, at);
  if (value === null) return schema.nullable ? [] : [`${at} is null`];
  if (schema.enum && !schema.enum.includes(value)) return [`${at} is ${String(value)}, not one of the documented values`];
  if (schema.type === "array") {
    if (!Array.isArray(value)) return [`${at} is not an array`];
    return value.flatMap((item, i) => (schema.items ? misfits(schema.items, item, `${at}[${i}]`) : []));
  }
  if (schema.type === "object") {
    if (typeof value !== "object") return [`${at} is not an object`];
    const record = value as Record<string, unknown>;
    return [
      ...(schema.required ?? []).filter((k) => record[k] === undefined).map((k) => `${at}.${k} is missing`),
      ...Object.entries(schema.properties ?? {}).flatMap(([k, s]) => (record[k] === undefined ? [] : misfits(s, record[k], `${at}.${k}`))),
    ];
  }
  if (schema.type === "integer") return Number.isInteger(value) ? [] : [`${at} is not an integer`];
  if (schema.type && typeof value !== schema.type) return [`${at} is not a ${schema.type}`];
  return [];
}

describe("openapi.yaml", () => {
  it("is a valid OpenAPI document", async () => {
    const result = await new Validator().validate(spec as never);
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("documents only paths that exist, with the method it says", () => {
    const paths = Object.keys(spec.paths);
    expect(paths.length).toBeGreaterThanOrEqual(5);
    for (const path of paths) {
      const file = routeFile(path);
      expect(existsSync(file), file).toBe(true);
      for (const method of Object.keys(spec.paths[path])) {
        expect(readFileSync(file, "utf8"), `${method} in ${file}`).toMatch(new RegExp(`export (async )?function ${method.toUpperCase()}\\b`));
      }
    }
  });

  it("leaves no public GET undocumented", () => {
    const routes = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "app/api"], { encoding: "utf8" })
      .split("\n")
      // A route under /api/queue answers only a signed-in shop, so it isn't part of the public API. Nor are PayPal's ways back
      // to a demo shop, a sandbox order or a shop connecting its PayPal account: they're where PayPal's page sends a person, and nothing a client calls.
      .filter((f) => f.endsWith("/route.ts") && !f.startsWith("app/api/queue/") && f !== "app/api/demo/buy/paypal/return/route.ts" && f !== "app/api/shopper/return/route.ts" && f !== "app/api/shop/paypal/back/route.ts" && /export (async )?function GET\b/.test(readFileSync(f, "utf8")));
    expect(routes.length).toBeGreaterThanOrEqual(5);
    expect(routes.sort()).toEqual(Object.keys(spec.paths).filter((p) => spec.paths[p].get).map(routeFile).sort());
  });

  describe("the answers the code really gives", () => {
    let db: Awaited<ReturnType<typeof testDb>>;
    let runId: string;
    const schemaFor = (path: string, status = "200") =>
      (spec.paths[path].get as { responses: Record<string, { content: { "application/json": { schema: Schema } } }> }).responses[status].content["application/json"].schema;

    beforeAll(async () => {
      db = await testDb();
      await migrate(db);
      const fixture = readFileSync("test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", "utf8");
      const fetchImpl = async () => new Response(fixture, { status: 200, headers: { "content-type": "application/json" } });
      await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
      const client: PayPalClient = {
        request: (async (_method: Method, path: string) => {
          const found = answerSearch(path, false);
          if (found) return found;
          throw new Error(`unexpected ${path}`);
        }) as PayPalClient["request"],
      };
      runId = (await runReplay(db, client, { today: "2026-11-06", now: new Date("2026-11-06T15:00:00Z"), secret: "k".repeat(32) })).runId;
    }, 60_000);
    afterAll(async () => {
      await db.close();
    });

    it("/api/check, with and without results", async () => {
      const hit = await checkText(db, { title: "Baby Brezza sterilizer", model: "BRZ0083" }, "2026-11-06");
      expect(hit.results.length).toBeGreaterThan(0);
      expect(misfits(schemaFor("/api/check"), hit)).toEqual([]);
      expect(misfits(schemaFor("/api/check"), await checkText(db, { title: "zzqx vvbn", model: "" }, "2026-11-06"))).toEqual([]);
    });

    it("says so when it couldn't judge everything near, and judges model hits first, so one can't be crowded out", async () => {
      const crowded = await checkText(db, { title: "high chair", model: "BRZ0083" }, "2026-11-06", { maxCandidates: 1 });
      expect(crowded.results[0]).toMatchObject({ recallNumber: "27072", verdict: "MATCH" });
      expect(crowded.notJudged).toBeGreaterThan(0);
      expect(misfits(schemaFor("/api/check"), crowded)).toEqual([]);
      const whole = await checkText(db, { title: "Baby Brezza sterilizer", model: "BRZ0083" }, "2026-11-06");
      expect(whole.notJudged).toBe(0);
    });

    it("says how many more results there are than it lists", async () => {
      const few = await checkText(db, { title: "high chair", model: "" }, "2026-11-06", { maxResults: 1 });
      expect(few.results).toHaveLength(1);
      expect(few.more).toBeGreaterThanOrEqual(0);
      expect(few.results.length + few.more + few.cleared + few.notJudged).toBeGreaterThan(0);
    });

    it("/api/replay/{runId}", async () => {
      const replay = await loadReplay(db, runId);
      expect(replay?.rows.length).toBeGreaterThan(0);
      expect(misfits(schemaFor("/api/replay/{runId}"), replay)).toEqual([]);
    });

    it("/api/proof/{runId}", async () => {
      expect(misfits(schemaFor("/api/proof/{runId}"), await proveReplay(db, runId))).toEqual([]);
    });

    it("/api/recalls/today/matches", async () => {
      const day = await latestRecallDay(db);
      expect(day?.recalls.length).toBeGreaterThan(0);
      expect(misfits(schemaFor("/api/recalls/today/matches"), { shop: "demo", ...day })).toEqual([]);
    });

    it("/api/health", async () => {
      expect(misfits(schemaFor("/api/health"), await getHealth(db, { PAYPAL_WEBHOOK_ID: "x", RECORD_HMAC_SECRET: "r".repeat(32) }))).toEqual([]);
    });

    it("this check can fail: a missing field and a wrong type are both caught", () => {
      expect(misfits(schemaFor("/api/check"), { results: [], cleared: "none", checked: { recalls: 1 } })).toEqual([
        "answer.more is missing",
        "answer.notJudged is missing",
        "answer.mentioned is missing",
        "answer.note is missing",
        "answer.cleared is not an integer",
        "answer.checked.yearsMissing is missing",
      ]);
    });
  });
});
