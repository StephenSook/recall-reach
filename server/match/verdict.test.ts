import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRecalls, type Recall } from "../cpsc/schema";
import { brandOf, fullScopeInRecord, limitedWithinModel, modelTokens, salePath, verdictFor } from "./verdict";

// Real CPSC records (saved 2026-11-05). The matcher is tested on what CPSC actually wrote.
const { valid } = parseRecalls(
  JSON.parse(readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8")),
);
const recall = (n: string): Recall => {
  const found = valid.find((v) => v.recall.recallNumber === n);
  if (!found) throw new Error(`recall ${n} is not in the fixture`);
  return found.recall;
};
const BREZZA = recall("27072");
const PAPABLIC = recall("27027");
const COSTWAY = recall("27040");

describe("brandOf", () => {
  it("reads the firm from CPSC's title, without company words", () => {
    expect(brandOf(BREZZA.title)).toBe("Baby Brezza");
    expect(brandOf(PAPABLIC.title)).toBe("Papablic");
    expect(brandOf(COSTWAY.title)).toBe("Costway");
    expect(brandOf("Little Loves & Co. Recalls Youth Clothing with Drawstrings")).toBe("Little Loves");
  });

  it("returns null when the title names no firm", () => {
    expect(brandOf("Infant Swings Recalled Due to Fall Hazard")).toBeNull();
  });
});

describe("modelTokens", () => {
  it("finds the model numbers CPSC names", () => {
    expect(modelTokens(BREZZA.description)).toEqual(["BRZ0083", "BRZ0154", "BRZ0156"]);
    expect(modelTokens(PAPABLIC.description)).toEqual(["PAPA03001AI"]);
  });

  it("finds none where CPSC names none", () => {
    expect(modelTokens(COSTWAY.description)).toEqual([]);
  });

  it("does not take units for model numbers", () => {
    expect(modelTokens("A 20V drill and a 1500W heater, 30000MAH")).toEqual([]);
  });
});

describe("verdictFor", () => {
  it("MATCH: the title names a recalled model", () => {
    const v = verdictFor(BREZZA, { title: "Baby Brezza SuperFast Sterilizer Dryer BRZ0083" });
    expect(v.verdict).toBe("MATCH");
    expect(v.matched).toEqual(expect.arrayContaining(["brand: Baby Brezza", "model: BRZ0083"]));
    expect(v.missing).toEqual([]);
  });

  it("finds the model in the description too, in any case", () => {
    const v = verdictFor(BREZZA, { title: "Baby Brezza sterilizer", description: "Model brz0154, used twice" });
    expect(v.verdict).toBe("MATCH");
  });

  it("MATCH: a single-model recall, same line, and the title shows the printed look CPSC describes", () => {
    const v = verdictFor(PAPABLIC, { title: "Papablic bedside sleeper, gray stars and moon" });
    expect(v.verdict).toBe("MATCH");
    expect(v.matched).toEqual(expect.arrayContaining(["brand: Papablic", "look: gray, moon, star"]));
  });

  it("SCOPE_GAP: same brand and line, and the title cannot show which unit", () => {
    const v = verdictFor(COSTWAY, { title: "Costway high chair" });
    expect(v.verdict).toBe("SCOPE_GAP");
    expect(v.missing.length).toBeGreaterThan(0);
  });

  it("stays SCOPE_GAP on colors alone when CPSC gives no model to pin them to", () => {
    expect(verdictFor(COSTWAY, { title: "Costway high chair purple and white" }).verdict).toBe("SCOPE_GAP");
  });

  it("SCOPE_GAP names the models when CPSC lists several and the title shows none", () => {
    const v = verdictFor(BREZZA, { title: "Baby Brezza SuperFast Sterilizer Dryer" });
    expect(v.verdict).toBe("SCOPE_GAP");
    expect(v.missing).toEqual(["model number (CPSC lists BRZ0083, BRZ0154, BRZ0156)"]);
  });

  it("SCOPE_GAP, never CLEARED, when the brand matches and even one product word is shared", () => {
    expect(verdictFor(BREZZA, { title: "Baby Brezza Sterilizer" }).verdict).toBe("SCOPE_GAP");
  });

  it("an unbranded recall needs most of its product words before it can gap", () => {
    const unbranded = { ...COSTWAY, title: "Convertible High Chairs Recalled Due to Fall Hazard" };
    expect(verdictFor(unbranded, { title: "wooden high chair, convertible" }).verdict).toBe("SCOPE_GAP");
    expect(verdictFor(unbranded, { title: "armchair for adults, not high" }).verdict).toBe("CLEARED");
  });

  describe("a title that does not name the brand", () => {
    // Real product names of three high chair recalls (25318, 26061, 26121), same item, same answer expected.
    const named = (title: string, name: string) => ({ ...COSTWAY, title, products: [{ name, model: "", type: null, units: null }] });
    const LONG = named("Funlio Convertible High Chairs Recalled Due to Risk of Injury", "2-in-1 Funlio Convertible Baby High Chairs");
    const LONGER = named("5-in-1 Convertible High Chairs Recalled Due to Risk of Injury", "Harppa 5-in-1 Convertible High Chairs for Babies and Toddlers");
    const SHORT = named("Convertible High Chairs Recalled Due to Risk of Injury", "Baby High Chairs (convertible)");

    it.each([
      ["a long product name", LONG],
      ["a longer one", LONGER],
      ["a short one", SHORT],
    ])("gets the same answer with %s: the length of CPSC's wording decides nothing", (_name, recallRecord) => {
      const v = verdictFor(recallRecord, { title: "Costway high chair" });
      expect(v.verdict).toBe("SCOPE_GAP");
      expect(v.strength).toBe("PRODUCT_WORDS");
      expect(v.reason).toBe("The same kind of product, but nothing in the shop's text ties it to this recall.");
    });

    it("says which brand is not named, when CPSC's title gives one", () => {
      const honeyjoy = named("HONEYJOY Recalls Multiple Convertible and Foldable High Chairs Due to Risk of Suffocation", "HONEYJOY Convertible and Foldable High Chairs");
      const v = verdictFor(honeyjoy, { title: "Costway high chair" });
      expect(v.strength).toBe("PRODUCT_WORDS");
      expect(v.reason).toBe("The same kind of product, but the shop's text does not name HONEYJOY.");
    });

    it("clears on one shared word, and names the word", () => {
      const v = verdictFor(LONG, { title: "armchair for adults, not high" });
      expect(v.verdict).toBe("CLEARED");
      expect(v.strength).toBe("PRODUCT_WORDS");
      expect(v.reason).toBe('Shares only "high" with this recall.');
    });

    it("clears on no shared word, and says that rather than calling it a different product", () => {
      const v = verdictFor(BREZZA, { title: "Costway high chair" });
      expect(v.verdict).toBe("CLEARED");
      expect(v.strength).toBe("NO_SHARED_WORDS");
      expect(v.reason).toBe("Shares no product word with this recall, and does not name Baby Brezza.");
    });
  });

  describe("a recall limited to part of a model", () => {
    const DREO = recall("27054");

    it("doesn't confirm on the model alone, when CPSC limits it by date, lot or serial", () => {
      const v = verdictFor(DREO, { title: "DREO space heater DR-HSH015" }, { dateFilter: false });
      expect(v).toMatchObject({ verdict: "SCOPE_GAP", strength: "BRAND" });
      expect(v.missing.join(" ")).toContain("date, lot or serial");
      expect(v.reason).toContain("DR-HSH015");
    });

    it("isn't confirmed by a date in the title either: a person reads that", () => {
      expect(verdictFor(DREO, { title: "DREO space heater DR-HSH015 manufactured February 2026" }, { dateFilter: false }).verdict).toBe("SCOPE_GAP");
    });

    it.each(["27072", "27027", "27018"])("leaves recall %s alone, whose models CPSC doesn't limit", (number) => {
      expect(limitedWithinModel(recall(number).description)).toBe(false);
    });

    it("reads the limits CPSC really writes, and isn't fooled by where a thing was made", () => {
      expect(limitedWithinModel("Only units manufactured from April 2025 through January 2026 are included in this recall.")).toBe(true);
      expect(limitedWithinModel("The following serial numbers are included in this recall.")).toBe(true);
      expect(limitedWithinModel("Units with a date code between 2401 and 2412.")).toBe(true);
      expect(limitedWithinModel("They were manufactured in March 2024.")).toBe(true);
      expect(limitedWithinModel("They were manufactured in China and sold at stores.")).toBe(false);
      expect(limitedWithinModel("The serial number is printed on a label on the base.")).toBe(false);
    });
  });

  describe("a printed look", () => {
    it("doesn't count the pieces of a model code as a look: a different code ending stays a question", () => {
      const oneModel = { ...PAPABLIC, title: "Lutron Recalls Power Interfaces", description: "This recall involves power interfaces for LED tape lights, model LU-PH3-B.", products: [{ name: "Lutron power interfaces for LED tape lights" }] } as Recall;
      const v = verdictFor(oneModel, { title: "Lutron power interface for LED tape lights LU-PH3-C" }, { dateFilter: false });
      expect(v.verdict).toBe("SCOPE_GAP");
      expect(v.strength).not.toBe("CONFIRMED");
    });

    it("confirms nothing without the brand, even when the title shows CPSC's exact look", () => {
      const v = verdictFor(PAPABLIC, { title: "Bedside sleeper, gray stars and moon" });
      expect(v.verdict).toBe("SCOPE_GAP");
      expect(v.strength).toBe("PRODUCT_WORDS");
    });

    it("still confirms with the brand named", () => {
      expect(verdictFor(PAPABLIC, { title: "Papablic bedside sleeper, gray stars and moon" }).verdict).toBe("MATCH");
    });
  });

  describe("how strong the evidence is", () => {
    it("a recalled model is confirmed", () => {
      expect(verdictFor(BREZZA, { title: "Baby Brezza SuperFast Sterilizer Dryer BRZ0083" }).strength).toBe("CONFIRMED");
    });

    it("a printed look on a one-model recall is confirmed", () => {
      expect(verdictFor(PAPABLIC, { title: "Papablic bedside sleeper, gray stars and moon" }).strength).toBe("CONFIRMED");
    });

    it("the brand and a product word is a gap with the brand behind it", () => {
      const v = verdictFor(COSTWAY, { title: "Costway high chair" });
      expect(v.verdict).toBe("SCOPE_GAP");
      expect(v.strength).toBe("BRAND");
    });

    it("a sale from before first sale keeps what the texts share", () => {
      const v = verdictFor(COSTWAY, { title: "Costway high chair", orderedOn: "2000-01-01" });
      expect(v.verdict).toBe("CLEARED");
      expect(v.strength).toBe("BRAND");
    });

    it("the same brand with a different product still counts as the brand", () => {
      expect(verdictFor(BREZZA, { title: "Baby Brezza Formula Pro Advanced" }).strength).toBe("BRAND");
    });
  });

  it("CLEARED: same brand, a model CPSC did not list", () => {
    const v = verdictFor(BREZZA, { title: "Baby Brezza SuperFast Sterilizer Dryer BRZ00999" });
    expect(v.verdict).toBe("CLEARED");
    expect(v.reason).toMatch(/BRZ00999/);
  });

  it("CLEARED: same brand, a different product", () => {
    const v = verdictFor(BREZZA, { title: "Baby Brezza Formula Pro Advanced" });
    expect(v.verdict).toBe("CLEARED");
    expect(v.reason).toMatch(/different product/);
  });

  it("MATCH: a recalled model number wins even when the title never names the brand", () => {
    const v = verdictFor(BREZZA, { title: "SuperFast Sterilizer Dryer BRZ0083" });
    expect(v.verdict).toBe("MATCH");
    expect(v.matched).toContain("model: BRZ0083");
  });

  it("SCOPE_GAP, not CLEARED, when the brand is merely absent and the product words match", () => {
    const v = verdictFor(BREZZA, { title: "Sterilizer Dryer, lightly used" });
    expect(v.verdict).toBe("SCOPE_GAP");
    expect(v.missing.join(" ")).toMatch(/Baby Brezza/);
  });

  it("CLEARED: no brand, and only one product word in common", () => {
    expect(verdictFor(BREZZA, { title: "Bottle dryer rack" }).verdict).toBe("CLEARED");
  });

  it("an unrelated code in the title is not proof of a different model", () => {
    const v = verdictFor(BREZZA, { title: "Baby Brezza SuperFast Sterilizer Dryer X200" });
    expect(v.verdict).toBe("SCOPE_GAP");
  });

  it("reads a model written with different punctuation or case as the same model", () => {
    for (const title of ["Baby Brezza dryer BRZ-0083", "Baby Brezza dryer brz 0083 unit", "Baby Brezza dryer brz.0083", "Baby Brezza dryer BRZ_0083"]) {
      const v = verdictFor(BREZZA, { title });
      expect(["MATCH", "SCOPE_GAP"], title).toContain(v.verdict);
    }
    expect(verdictFor(BREZZA, { title: "Baby Brezza dryer BRZ-0083" }).verdict).toBe("MATCH");
  });

  it("a near-identical code may be a typo of a listed model, so it is a gap, not a clearance", () => {
    expect(verdictFor(BREZZA, { title: "Baby Brezza Sterilizer Dryer BRZOO83" }).verdict).toBe("SCOPE_GAP"); // O for 0
    expect(verdictFor(BREZZA, { title: "Baby Brezza Sterilizer Dryer BRZ0084" }).verdict).toBe("SCOPE_GAP"); // one digit off
  });

  it("a one-word product name can still relate when the title omits the brand", () => {
    const oneWord = { ...BREZZA, products: [{ name: "Teethers", model: "", type: null, units: null }] };
    expect(verdictFor(oneWord, { title: "Silicone teether" }).verdict).toBe("SCOPE_GAP");
  });

  it("an unbranded recall with a one-word product name can still relate", () => {
    const unbranded = { title: "Teethers Recalled Due to Choking Hazard", description: "Silicone teethers.", retailers: [], products: [{ name: "Teethers", model: "", type: null, units: null }] };
    expect(verdictFor(unbranded, { title: "Silicone teether" }).verdict).toBe("SCOPE_GAP");
  });

  it("never clears a title sharing product words when the record's list is elsewhere, even with no brand", () => {
    const partial = { ...BREZZA, description: `${BREZZA.description} Other models are listed below.` };
    expect(verdictFor(partial, { title: "Bottle dryer rack" }).verdict).toBe("SCOPE_GAP");
  });

  it("a variant of a listed model is a gap, not a clearance", () => {
    expect(verdictFor(BREZZA, { title: "Baby Brezza SuperFast Sterilizer Dryer BRZ0083A" }).verdict).toBe("SCOPE_GAP");
  });

  it("never clears on model or product when CPSC says the full list is elsewhere", () => {
    const partial = { ...BREZZA, description: `${BREZZA.description} Other affected models are listed below.` };
    const otherModel = verdictFor(partial, { title: "Baby Brezza SuperFast Sterilizer Dryer BRZ00999" });
    expect(otherModel.verdict).toBe("SCOPE_GAP");
    expect(otherModel.missing.join(" ")).toMatch(/CPSC/);
    expect(verdictFor(partial, { title: "Baby Brezza Formula Pro Advanced" }).verdict).toBe("SCOPE_GAP");
  });

  it("stays fast on very long shop text", () => {
    const started = performance.now();
    verdictFor(BREZZA, { title: "A".repeat(200_000), description: "A-1".repeat(100_000) });
    modelTokens("9-".repeat(200_000));
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it("the date filter clears a sale from before the product was first sold", () => {
    // CPSC: sold from January 2024.
    const v = verdictFor(BREZZA, { title: "Baby Brezza SuperFast Sterilizer Dryer BRZ0083", orderedOn: "2023-12-31" });
    expect(v.verdict).toBe("CLEARED");
    expect(v.reason).toMatch(/2024-01/);
  });

  it("the date filter keeps a sale in the first-sale month", () => {
    const v = verdictFor(BREZZA, { title: "Baby Brezza SuperFast Sterilizer Dryer BRZ0083", orderedOn: "2024-01-01" });
    expect(v.verdict).toBe("MATCH");
  });

  it("can be told to skip the date filter, for the eval's ablation row", () => {
    const v = verdictFor(
      BREZZA,
      { title: "Baby Brezza SuperFast Sterilizer Dryer BRZ0083", orderedOn: "2023-12-31" },
      { dateFilter: false },
    );
    expect(v.verdict).toBe("MATCH");
  });
});

describe("fullScopeInRecord, on CPSC's own words", () => {
  // Each is verbatim from the recall named. Read against all 1,855 descriptions from 2022 on.
  it.each([
    ["26724, a list cut off", "The model number and date code are printed on the neck tag. The following model numbers and date codes are included in the recall:"],
    ["26735, a list cut off", "The following SKUs are included in the recall and are located on the side of the product packaging:"],
    ["26734, a list cut off", "Recalled units have a model number beginning with PB. The model numbers in the recall include:"],
    ["23156, a new sentence where the list should start", "The following 15 scents of candles are included in the recall: The bag containing potassium hydroxide has a blue label"],
    ["26731, ends on the following", "and the following FD numbers which are visible on the underside of the Bluetooth speakers (sold in pairs)."],
    ["26763, a look-up", "Consumers can check if their VIN is included in this recall at https://www.triumphmotorcycles.com/owners/recalls"],
    ["26458, a look-up", "Consumers can check if their VIN is included in the recall at https://powersports.honda.com/recalls."],
    ["24288, a look-up with no address", "Consumers can check if their VIN is included in the recall at Honda Powersports & Motorcycle Recalls."],
    ["25338, a look-up", "Consumers should check their serial number at https://www.anker.com/product-recalls to determine whether their power bank is included in the recall."],
    ["24260, a look-up", "To see if your product is subject to this recall, visit www.goodmanmfg.com/package-recall."],
    ["23710, enter a number", "Consumers can enter their VIN at www.polaris.com/en-us/off-road-recalls/ to see if their snowmobile is included in any recalls."],
    ["24069, a tool", 'are subject to the recall must be identified through the use of the "Is my BlendJet 2 Recalled?" tool located at www.blendjet.com/safetyandrecall.'],
    ["23073, a questionnaire", "by completing the online questionnaire at www.simu.com/us/dmi6hzrecall or by contacting SIMU."],
    ["99036, the firm will say", "The manufacturers will help consumers determine if the nets need to be replaced."],
    ["24021, a dealer", "Consumers should visit authorized dealers who will disassemble and verify if a binding is included in this recall."],
    ["24377, numbers at a site", "The serial numbers of tractors included in this recall can be found at www.deere.com."],
    ["25124, a list at a site", "Consumers are urged to visit https://www.ariensco.com/safetyrecall for a list of recalled units."],
    ["24256, a list at a site", "A full list of serial numbers included in this recall are on the firm's website at www.kawasakienginesusa.com/product-recall.html."],
    ["23172, a list at a site", "This recall involves The Laundress Fabric Conditioner products, a complete list of which is available at www.TheLaundressRecall.com."],
    ["24314, a list at a site", "A list of affected special order numbers can be found at www.grandrapidschair.com/customer-service/product-safety-recall"],
    ["27055, details at a site", "Additional photos and model-identifying information are available on the recall website."],
    ["25157, directions at a site", "Please visit the Triangle Tube recall website for directions on identifying if you have a recalled boiler by serial number"],
    ["27041, ask the firm", "Consumers should contact Lithonia Lighting to confirm their Luminaire with adjustable tilt mounting arms are included in the recall."],
    ["23076, ask the firm", "Consumers can identify whether their Nomad is included in the recall by contacting BLU3 and providing the serial number for their Nomad."],
    ["26776, numbers below that never come", "The model and serial number are located inside the air conditioners. Only some serial numbers below have motors that are included in this recall."],
    ["24745, dates below that never come", "Only these models sold during the dates identified below are included in this recall."],
    ["26372, a table", "Only products with serial numbers listed in the table below are subject to recall."],
    ["25009, a chart", "The following chart includes a complete list of Snuga Swing models included in the recall."],
    ["26054, certain VINs", "This recall involves certain VINs of Polaris Model Year 2025-2026 Ranger XP 1000 NorthStar and Ranger Crew XP 1000 NorthStar ROVs."],
    ["26203, certain serial numbers", "Vision models T9800, TF20, T40, and T80 treadmills with certain serial numbers."],
    ["23132, certain models", "This recall involves certain models of Zinus SmartBase Euro Slats metal mattress platform bed frames."],
    ["24127, certain, and no model number anywhere", 'This recall involves certain Awesafe biometric gun safes. The recalled gun safes are black, can fit two pistols, and have the brand name "Awesafe" on the front.'],
    ["25338, qualifying", "Only model number A1263 power banks sold in the U.S. with qualifying serial numbers are included in the recall."],
  ])("reads %s as incomplete", (_about, description) => {
    expect(fullScopeInRecord({ description })).toBe(false);
  });

  it.each([
    ["26688, the list right there", "The following model numbers are included in the recall: Product Name Model Number Baby Jumper jumper-01 Baby Swing swing-1 2-in-1 Jumper & Swing-A jumper-01"],
    ["27076, a table right there", "The following styles and models are included in the recall:  Style Name\tModel Number Darkhouse\tMAT-030 Arean\tMAT-031"],
    ["22047, names and no digits", "Models include: Eclipse, Infinity, Kwiklift, MR and HR. Model names are located on the"],
    ["24209, numbers in the sentence", 'The cribs have one of the following SKU numbers 246898, 534758, 534987, 535020 and 405394 along with the brand "Crate&Barrel" listed on a label located on the mattress support board.'],
    ["27010, certain, with its models named", "This recall involves certain Walmart Expert Grill metal wire bristle grill brushes. The brushes have black plastic or stainless-steel handles. Some brushes come with metal scraper attached. The following model numbers are included in this recall and can be found on the product packaging or a sticker/tag attached to the brush: Model No. Brush Description Distribution Dates EX5607031616002"],
    ["25109, certain, with its models named", "This recall involves certain Matrix-brand Training Cycles models CXP-03, CXC-02, CXM-03, CXV and CXM-02."],
    ["26791, battery disposal", "Before taking your battery or device to a HHW collection center, contact it ahead of time and ask whether it accepts recalled lithium-ion batteries."],
    ["26340, CPSC's own site", "CPSC's Anchor It! website, www.anchorit.gov/, has educational materials available to the public"],
    ["23121, an address printed on the label", 'The sewn-in neck label displays the garment size and "The Oaks Apparel," "Est. 2014" and "www.oaksapparel.com."'],
    ["26756, colors at a site", "The products are sold in stainless steel, white and 13 other colors, which can be found at www.agarangeusa.com and www.lacornueusa.com."],
    ["26699, a site mentioned", "The model number LTBBHG006 does not appear on the product but it was included in the Best Buy website listing."],
    ["25036, where the model is printed", "The model number is located on the manufacturer's label on the underside of each unit."],
    ["24013, a safety step", "Consumers should always check that the inner pot is not filled beyond two-thirds capacity when pressure cooking,"],
    ["26330, an app that also says which model", "You can also determine which model you have by connecting your bicycle to the Specialized app."],
    ["26623, a word that happens to be below", 'and a picture of the Space king characters below it. Only the copper cups are included in this recall.'],
  ])("reads %s as full", (_about, description) => {
    expect(fullScopeInRecord({ description })).toBe(true);
  });
});

describe("fullScopeInRecord", () => {
  it("is false when CPSC says the list is elsewhere", () => {
    expect(fullScopeInRecord(recall("27051"))).toBe(false);
  });

  it("is true when the record holds the scope", () => {
    expect(fullScopeInRecord(COSTWAY)).toBe(true);
  });
});

describe("salePath", () => {
  it("is notice only for a sale before the recall date", () => {
    expect(salePath("2026-09-15", "2026-11-05")).toBe("NOTICE_ONLY");
  });

  it("goes to review for a sale on the recall's calendar date", () => {
    expect(salePath("2026-11-05", "2026-11-05")).toBe("REVIEW");
  });

  it("is refund eligible only for a later date", () => {
    expect(salePath("2026-11-06", "2026-11-05")).toBe("REFUND_ELIGIBLE");
  });
});
