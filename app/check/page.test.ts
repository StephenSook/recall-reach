import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pullRecalls } from "@/server/cpsc/pull";
import { migrate } from "@/server/db/migrate";
import type { Queryable } from "@/server/db/types";
import { testDb } from "@/test/pglite";

let db: Queryable;
let visitor = "198.51.100.1";
const getDb = vi.hoisted(() => vi.fn());
vi.mock("@/server/db/pg", () => ({ getDb }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "true-client-ip": visitor }) }));

import CheckPage from "./page";

const fixtureText = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
let nextVisitor = 0;
const html = async (query: Record<string, string> = {}) => {
  visitor = `198.51.100.${++nextVisitor % 250}`;
  return renderToStaticMarkup(createElement("div", null, await CheckPage({ searchParams: Promise.resolve(query) })));
};
const unescape = (text: string) => text.replaceAll("&#x27;", "'");

describe("the check page", () => {
  let real: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    real = await testDb();
    await migrate(real);
    db = real;
    getDb.mockImplementation(() => db);
    const fetchImpl = async () => new Response(fixtureText, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(real, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
    getDb.mockClear();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await real.close();
  });

  describe("checking one item", () => {
    it("opens with the form, and doesn't touch the database until something is typed", async () => {
      const page = unescape(await html());
      expect(page).toContain("<h1>Check one item</h1>");
      expect(page).toContain("Before you take something in or put it out.");
      expect(page).toContain("What's on the label");
      expect(page).toContain("Model number, if you can see it");
      expect(page).toContain(">Check it<");
      expect(page).not.toContain('data-testid="item-answer"');
      expect(getDb).not.toHaveBeenCalled();
    });

    it("comes before the order file", async () => {
      const page = await html();
      expect(page.indexOf('data-testid="item-form"')).toBeLessThan(page.indexOf("Your order file"));
    });

    it("names a recall from its model, with a link to read it here", async () => {
      const page = unescape(await html({ title: "Baby Brezza sterilizer", model: "BRZ0083" }));
      expect(page).toContain("This matches a recall. That doesn't say this one is recalled: read it and compare the model.");
      expect(page).toContain('href="/recall/27072"');
      expect(page).toContain("27072");
    });

    it("reads a maker typed alone as something to read, not as nothing", async () => {
      const page = unescape(await html({ title: "Baby Brezza", model: "" }));
      expect(page).toContain("The maker matches, and nothing else does.");
      expect(page).toContain('href="/recall/27072"');
      expect(page).not.toContain("No recall in");
    });

    it("keeps what was typed in the form, and says what it checked", async () => {
      const page = await html({ title: "Costway high chair", model: "" });
      expect(page).toContain('value="Costway high chair"');
      expect(page).toContain("Checked: Costway high chair");
    });

    it("draws what's typed as text, never as markup", async () => {
      const page = await html({ title: '<img src=x onerror="alert(1)">', model: "" });
      expect(page).not.toContain("<img src=x");
    });

    it("won't call a store of recalls with years missing a clean answer", async () => {
      const page = unescape(await html({ title: "zzqx vvbn plmk", model: "" }));
      expect(page).toContain("Can't say yet.");
      expect(page).not.toContain("No recall in");
    });

    it("asks for something when nothing was typed, without reading the database", async () => {
      expect(unescape(await html({ title: "  ", model: "" }))).toContain("Type what's on the label, or a model number.");
      expect(getDb).not.toHaveBeenCalled();
    });

    it("says the check couldn't run when the database fails, and doesn't repeat what was typed", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      db = {
        query: async () => {
          throw new Error("failed on a query holding SECRET-TITLE-TEXT");
        },
        exec: async () => {},
      };
      const page = unescape(await html({ title: "SECRET-TITLE-TEXT", model: "" }));
      expect(page).toContain("The check could not run. Please try again.");
      expect(page).not.toContain("No recall in");
      expect(JSON.stringify(logged.mock.calls)).not.toContain("SECRET-TITLE-TEXT");
    });

    it("shares the public checks' limit, and says so", async () => {
      const again = async () => {
        visitor = "203.0.113.77";
        return renderToStaticMarkup(createElement("div", null, await CheckPage({ searchParams: Promise.resolve({ title: "chair", model: "" }) })));
      };
      let page = await again();
      for (let i = 0; i < 60; i++) page = await again();
      expect(page).toContain("Too many checks from here. Try again in an hour.");
    }, 60_000);

    it("stores nothing, and isn't counted as an outside call", async () => {
      await html({ title: "SECRET-TITLE chair", model: "" });
      const { rows } = await real.query("select (select count(*)::int from shops) as shops, (select count(*)::int from shop_items) as items, (select count(*)::int from public_calls) as calls");
      expect(rows).toEqual([{ shops: 0, items: 0, calls: 0 }]);
    });
  });

  describe("what sits under the order file", () => {
    it("folds what it keeps and checks into one closed section", async () => {
      const page = unescape(await html());
      const fold = page.slice(page.indexOf("<details"), page.indexOf("</details>"));
      expect(fold).toContain("What this keeps and checks");
      expect(fold).not.toMatch(/<details[^>]* open/);
      expect(fold).toContain("order_number, title, quantity");
      expect(fold).toContain("We check CPSC recalls from 2022 on.");
      expect(fold).toContain("buyer emails are encrypted");
    });

    it("keeps the car seat line and the sample file out of the fold", async () => {
      const page = await html();
      const fold = page.slice(page.indexOf("<details"), page.indexOf("</details>"));
      expect(page).toContain('href="https://www.nhtsa.gov/recalls"');
      expect(fold).not.toContain("nhtsa.gov");
      expect(page).toContain('href="/sample-order-file.csv"');
      expect(fold).not.toContain("sample-order-file");
    });

    it("still shows the order file's errors, at the top where a phone lands", async () => {
      const page = await html({ error: "TOO_MANY" });
      expect(page.indexOf('role="alert"')).toBeGreaterThan(-1);
      expect(page.indexOf('role="alert"')).toBeLessThan(page.indexOf('data-testid="item-form"'));
    });
  });
});
