// A second model family's blind check of Claude's eval labels. This re-scores the stored answers and reads /eval's sentence, so the
// page can't drift from the files. It's a check by a model, not an audit by a person.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = "eval/cross-model";
const read = (name: string) => JSON.parse(readFileSync(`${dir}/${name}`, "utf8"));

type Label = "NEAR_MISS" | "NO_MATCH" | "UNSURE" | "MATCH";
const sample = read("sample.json") as { seed: number; pairs: { pair_id: string; recall_number: string; listing_title: string; label: Label; split: string }[] };
const blind = read("blind-pairs.json") as { seed: number; pairs: Record<string, unknown>[] };
const answers = read("codex-answers.json") as { seed: number; answers: Record<string, string> };
// Claude's NEAR_MISS and NO_MATCH both mean a look-alike.
const SAME_AS: Record<Label, string> = { NEAR_MISS: "LOOKALIKE", NO_MATCH: "LOOKALIKE", UNSURE: "UNSURE", MATCH: "MATCH" };
const isLookalike = (label: Label) => label === "NEAR_MISS" || label === "NO_MATCH";

describe("the blind check of Claude's labels by a second model", () => {
  it("answered every pair of the same sample", () => {
    expect(answers.seed).toBe(sample.seed);
    expect(blind.seed).toBe(sample.seed);
    expect(Object.keys(answers.answers).sort()).toEqual(sample.pairs.map((p) => p.pair_id).sort());
    expect(sample.pairs).toHaveLength(50);
  });

  it("never saw Claude's labels", () => {
    expect(blind.pairs).toHaveLength(50);
    for (const pair of blind.pairs) expect(Object.keys(pair)).not.toContain("label");
    expect(JSON.stringify(blind.pairs)).not.toMatch(/NEAR_MISS|NO_MATCH|"UNSURE"/);
  });

  it("agreed on 34 of 50", () => {
    expect(sample.pairs.filter((p) => answers.answers[p.pair_id] === SAME_AS[p.label])).toHaveLength(34);
  });

  it("said the title can't settle it on all 16 of the others", () => {
    const others = sample.pairs.filter((p) => answers.answers[p.pair_id] !== SAME_AS[p.label]);
    expect(others).toHaveLength(16);
    expect(others.every((p) => isLookalike(p.label) && answers.answers[p.pair_id] === "UNSURE")).toBe(true);
  });

  it("called none of Claude's look-alikes the recalled product", () => {
    const lookalikes = sample.pairs.filter((p) => isLookalike(p.label));
    expect(lookalikes).toHaveLength(44);
    expect(lookalikes.filter((p) => answers.answers[p.pair_id] === "MATCH")).toEqual([]);
  });

  it("is what /eval says", () => {
    const page = readFileSync("app/eval/page.tsx", "utf8");
    expect(page).toContain("checked 50 of them: it agreed on 34, said the title can&apos;t settle it on the other 16");
    expect(page).toContain("No person has audited them");
  });

  it("checked the labels the eval really uses", () => {
    const rows = new Map(readFileSync("eval/pairs.csv", "utf8").trim().split("\n").slice(1).map((line) => {
      const fields = line.split(",");
      return [fields[0], { label: fields.at(-2), split: fields.at(-1) }] as const;
    }));
    for (const pair of sample.pairs) expect(rows.get(pair.pair_id), pair.pair_id).toEqual({ label: pair.label, split: "held_out" });
  });
});
