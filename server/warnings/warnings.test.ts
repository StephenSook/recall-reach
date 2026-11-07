import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import { createShop } from "../import/store";
import { checkStoredShopsAgainstWarnings, checkTitlesAgainstWarnings, checkShopAgainstWarnings, cleanCpscText, descriptiveWords, makerOf, parseWarningsCsv, readWarningsFor, refreshWarnings, storeWarnings, type Warning, warningCount, WarningsUnreadable } from "./warnings";

const HEADER =
  '﻿"Product Safety Warning Number","Product Safety Warning Date","Product Safety Warning Title","Name of product","Description","Hazard Description","Consumer Action","Original Product Safety Warning Announcement","Units","Incidents","Sold At Label","Sold At","Importers","Manufacturers","Distributors","Manufactured In","Custom Label","Custom Field"';
const row = (over: Partial<Record<"number" | "date" | "title" | "name" | "description" | "hazard" | "action" | "soldAt", string>> = {}) =>
  [
    over.number ?? "27-002",
    over.date ?? "October 1, 2026",
    over.title ?? "CPSC Warns Consumers to Stop Using Mbabyjon Crib Bumpers Immediately",
    over.name ?? "Mbabyjon Crib Bumpers",
    over.description ?? "CPSC is warning consumers.",
    over.hazard ?? 'The bumpers pose a "suffocation" risk, and more.',
    over.action ?? "Stop using them, and dispose of them.",
    "",
    "",
    "",
    "Sold Online At",
    over.soldAt ?? "Amazon.com for about $20.",
    "",
    "",
    "",
    "China",
    "",
    "",
  ]
    .map((v) => `"${v.replace(/"/g, '""')}"`)
    .join(",");
const csv = (...rows: string[]) => [HEADER, ...rows].join("\r\n");
const many = (n: number) => Array.from({ length: n }, (_, i) => row({ number: `26-${i}`, name: `Maker${i} Thing`, title: `CPSC Warns About Maker${i}` }));
const WARNING: Warning = { number: "27-002", warnedOn: "2026-10-01", title: "CPSC Warns", product: "Mbabyjon Crib Bumpers", description: "d", hazard: "h", consumerAction: "a", soldAt: "s" };

describe("reading CPSC's warnings file", () => {
  it("reads a row's fields, with CPSC's words as they are", () => {
    expect(parseWarningsCsv(csv(row(), ...many(100)))[0]).toEqual({
      number: "27-002",
      warnedOn: "2026-10-01",
      title: "CPSC Warns Consumers to Stop Using Mbabyjon Crib Bumpers Immediately",
      product: "Mbabyjon Crib Bumpers",
      description: "CPSC is warning consumers.",
      hazard: 'The bumpers pose a "suffocation" risk, and more.',
      consumerAction: "Stop using them, and dispose of them.",
      soldAt: "Amazon.com for about $20.",
    });
  });

  it.each([
    ["an HTML page served with 200", "<!doctype html><html><body>Request blocked</body></html>"],
    ["a CSV with other columns", `"a","b"\r\n"1","2"`],
    ["a file with far too few rows", csv(row())],
    ["nothing", ""],
  ])("refuses %s, and never reads it as data", (_name, text) => {
    expect(() => parseWarningsCsv(text)).toThrow(WarningsUnreadable);
  });

  it("cleans a real row, 27-002, with a link fragment and an entity, and changes nothing else", () => {
    const real =
      'The crib bumpers can obstruct an infant\u2019s breathing, posing a risk of serious injury or death from suffocation. Padded crib bumpers are banned under the https://www.cpsc.gov/Newsroom/News-Releases/2023/CPSC-Approves-Rules-Im\u2026 lang="EN-US">Safe Sleep for Babies Act.&nbsp;';
    expect(cleanCpscText(real)).toBe("The crib bumpers can obstruct an infant\u2019s breathing, posing a risk of serious injury or death from suffocation. Padded crib bumpers are banned under the Safe Sleep for Babies Act.");
  });

  it("takes out a cut-off link standing alone, which is the export's leftover and not CPSC's words", () => {
    expect(cleanCpscText("as required by the https://www.cpsc.gov/Business--Manufacturing/Busines\u2026 Act, posing a risk")).toBe("as required by the Act, posing a risk");
  });

  it("leaves a comparison alone: only real markup comes out", () => {
    expect(cleanCpscText("Lead levels <100 ppm and cadmium >75 ppm are hazardous.")).toBe("Lead levels <100 ppm and cadmium >75 ppm are hazardous.");
    expect(cleanCpscText("A <b>bold</b> word and a <a href='x'>link</a>.")).toBe("A bold word and a link.");
  });

  it("leaves a plain web address alone", () => {
    expect(cleanCpscText("Go to https://www.cpsc.gov/Warnings for more.")).toBe("Go to https://www.cpsc.gov/Warnings for more.");
  });

  it("takes out the markup CPSC's export leaves in, and keeps every word", () => {
    const rows = parseWarningsCsv(
      csv(
        row({
          hazard: 'Padded crib bumpers are banned under the https://www.cpsc.gov/Newsroom/News-Releases/2023/CPSC-Approves-Rules-Im\u2026 lang="EN-US">Safe Sleep for Babies Act.&nbsp;',
          action: "Stop using them &amp; dispose of them.&nbsp;",
        }),
        ...many(100),
      ),
    );
    expect(rows[0].hazard).toBe("Padded crib bumpers are banned under the Safe Sleep for Babies Act.");
    expect(rows[0].consumerAction).toBe("Stop using them & dispose of them.");
  });

  it("leaves out a row with no number or no date it can read, and takes the rest", () => {
    const rows = parseWarningsCsv(csv(row({ number: "" }), row({ number: "1", date: "not a date" }), ...many(100)));
    expect(rows).toHaveLength(100);
  });
});

describe("who counts as a maker", () => {
  const described = descriptiveWords(["Mbabyjon Crib Bumpers", "Some Magnetic Balls"]);

  it.each([
    ["Mbabyjon Crib Bumpers", "mbabyjon"],
    ["Aila+Aiden Baby Loungers", "aila+aiden"],
    ["XZV baby loungers", "xzv"],
  ])("takes %s", (product, maker) => {
    expect(makerOf(product, described)).toBe(maker);
  });

  it.each(["Magnetic Chess Games", "Kids Light Up Ballet Skirts", "Baby Loungers", "5-IN-1 Toddler Instruments", "Hair Dryer Brushes", "Toy sets", "Big red ball"])("refuses %s: that describes a product", (product) => {
    expect(makerOf(product, described)).toBeNull();
  });
});

describe("keeping them", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
  });
  afterEach(async () => {
    await db.close();
  });

  const answer = (text: string, status = 200, type = "text/csv") => vi.fn(async () => new Response(text, { status, headers: { "content-type": type } }));
  const NOW = new Date("2026-11-07T12:00:00Z");

  it("stores them apart from recalls, once each, and takes CPSC's newer words", async () => {
    await storeWarnings(db, [WARNING]);
    await storeWarnings(db, [{ ...WARNING, hazard: "newer" }]);
    expect(await warningCount(db)).toBe(1);
    const { rows } = await db.query<{ hazard: string }>("select hazard from safety_warnings");
    expect(rows[0].hazard).toBe("newer");
    expect((await db.query("select 1 from recalls")).rows).toEqual([]);
  });

  it("reads the file and notes when, once a day", async () => {
    const fetchImpl = answer(csv(row(), ...many(100)));
    expect(await refreshWarnings(db, { now: NOW, fetchImpl: fetchImpl as unknown as typeof fetch })).toBe("READ");
    expect(await warningCount(db)).toBe(101);
    expect(await refreshWarnings(db, { now: new Date(NOW.getTime() + 3_600_000), fetchImpl: fetchImpl as unknown as typeof fetch })).toBe("FRESH");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps what it holds, and doesn't note a read, when CPSC answers an error page with 200", async () => {
    await storeWarnings(db, [WARNING]);
    const fetchImpl = answer("<html>blocked</html>", 200, "text/html");
    await expect(refreshWarnings(db, { now: NOW, fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toBeInstanceOf(WarningsUnreadable);
    expect(await warningCount(db)).toBe(1);
    expect((await db.query("select 1 from safety_warning_reads")).rows).toEqual([]);
  });

  it("calls a failed status unreadable too", async () => {
    await expect(refreshWarnings(db, { now: NOW, fetchImpl: answer("busy", 503) as unknown as typeof fetch })).rejects.toBeInstanceOf(WarningsUnreadable);
  });

  describe("a shop's titles against them", () => {
    let shopId: string;
    beforeEach(async () => {
      shopId = await createShop(db, { name: "Shop", kind: "REAL" });
      await storeWarnings(db, [WARNING, { ...WARNING, number: "26-1", product: "Other Maker Walkers", title: "CPSC Warns", warnedOn: "2026-09-01" }]);
    });

    it("finds a title naming the maker and the product", async () => {
      expect(await checkTitlesAgainstWarnings(db, shopId, ["Mbabyjon crib bumpers, 4 piece"])).toBe(1);
      expect(await readWarningsFor(db, shopId)).toEqual([{ ...WARNING, itemTitle: "Mbabyjon crib bumpers, 4 piece" }]);
    });

    it.each(["crib bumpers", "Baby walkers", "Mbabyjon", "Bumper stickers"])("leaves %s alone: a shared word is not a warning about this item", async (title) => {
      expect(await checkTitlesAgainstWarnings(db, shopId, [title])).toBe(0);
    });

    it("reads a long title only as far as a title can be", async () => {
      expect(await checkTitlesAgainstWarnings(db, shopId, [`${"x ".repeat(300)}Mbabyjon crib bumpers`])).toBe(0);
      expect(await checkTitlesAgainstWarnings(db, shopId, [`Mbabyjon crib bumpers ${"x ".repeat(300)}`])).toBe(1);
    });

    it("adds each title once, however often it's checked", async () => {
      await checkTitlesAgainstWarnings(db, shopId, ["Mbabyjon crib bumpers"]);
      await checkTitlesAgainstWarnings(db, shopId, ["Mbabyjon crib bumpers"]);
      expect(await readWarningsFor(db, shopId)).toHaveLength(1);
    });

    it("reads the shop's own order lines and listings", async () => {
      await db.query("insert into shop_items (shop_id, title, source) values ($1, 'Mbabyjon crib bumpers', 'test')", [shopId]);
      await checkShopAgainstWarnings(db, shopId);
      expect((await readWarningsFor(db, shopId)).map((w) => w.number)).toEqual(["27-002"]);
    });

    it("takes up where it left off: a shop not yet checked since the last read goes first", async () => {
      const second = await createShop(db, { name: "Second", kind: "REAL" });
      await db.query("insert into shop_items (shop_id, title, source) values ($1, 'Mbabyjon crib bumpers', 'test'), ($2, 'Mbabyjon crib bumpers', 'test')", [shopId, second]);
      await db.query("insert into safety_warning_reads (ok_at) values ('2026-11-07T00:00:00Z')");
      expect(await checkStoredShopsAgainstWarnings(db, { budgetMs: -1 })).toEqual({ checked: 0, waiting: 2 });
      expect(await checkStoredShopsAgainstWarnings(db, { budgetMs: 60_000, maxShops: 1 })).toEqual({ checked: 1, waiting: 1 });
      expect(await checkStoredShopsAgainstWarnings(db, { budgetMs: 60_000 })).toEqual({ checked: 1, waiting: 0 });
      expect((await readWarningsFor(db, shopId)).length + (await readWarningsFor(db, second)).length).toBe(2);
      expect(await checkStoredShopsAgainstWarnings(db, { budgetMs: 60_000 })).toEqual({ checked: 0, waiting: 0 });
    });

    it("never fails the shop's check", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(checkShopAgainstWarnings({ query: async () => Promise.reject(new Error("down")) } as unknown as typeof db, shopId)).resolves.toBe(false);
      error.mockRestore();
    });

    it("gives a shop only its own, and goes when the shop goes", async () => {
      const other = await createShop(db, { name: "Other", kind: "REAL" });
      await checkTitlesAgainstWarnings(db, shopId, ["Mbabyjon crib bumpers"]);
      expect(await readWarningsFor(db, other)).toEqual([]);
      await db.query("delete from shops where id = $1", [shopId]);
      expect((await db.query("select 1 from safety_warning_matches")).rows).toEqual([]);
    });
  });
});
