import { describe, expect, it } from "vitest";
import { findViolations, judge, MIN_FILES } from "./publicGuard";

const file = (path: string, text = "ordinary words") => ({ path, text });
const plenty = Array.from({ length: MIN_FILES }, (_, i) => file(`server/file${i}.ts`));

describe("findViolations", () => {
  it.each(["BUILD-BRIEF.md", "BUILD-BRIEF-4.md", "CLAUDE.local.md", "research/PLAN.md", "research/film/take.mp4", "docs/BUILD-BRIEF.md", "docs/CLAUDE.local.md", "docs/research/notes.txt", ".claude/settings.local.json", ".env", ".env.local", "deploy/.env.production", "server.pem", "keys/id.key", "test-results/out.png", "playwright-report/index.html", ".next/trace"])(
    "catches the file %s",
    (path) => {
      expect(findViolations([file(path)])).toEqual([`${path}: shouldn't ship`]);
    },
  );

  it.each(["README.md", ".env.example", "server/research.ts", "docs/replay/run.json", "app/env.ts", "CLAUDE.md.txt"])("leaves %s alone", (path) => {
    expect(findViolations([file(path)])).toEqual([]);
  });

  it.each([
    ["a home directory", "see /Users/someone/dev/notes"],
    ["a Linux home directory", "see /home/someone/notes"],
    ["a private brief", "as BUILD-BRIEF-3 says"],
    ["local instructions", "see CLAUDE.local for this"],
    ["the research folder", "wording from research/NOTES.md"],
    ["the research folder, one level up", "read ../research/NOTES.md"],
    ["a nested research path", "See research/a/NOTES.md"],
    ["a research file with a digit", "See research/NOTES-2.md"],
    ["a research script, any extension", "Ported from the EDA script (research/eda/analysis.py: sale_window)"],
    ["a research folder, no file named", "Shaped as Channel3 answered (research/raw/channel3), with invented products"],
    ["a hidden research file", "See research/.notes.md"],
    ["a file in a hidden research folder", "See research/.private/notes.md"],
    ["a research path through a ./ segment", "See research/./PLAN.md"],
    ["a research path through a ../ segment", "See research/../research/PLAN.md"],
    ["a research path through ./ segments in a nested folder", "See research/././briefs/NOTES.md"],
    ["a research folder ending in a slash", "See research/raw/ for the answers"],
    ["a research file with a space, in backticks", "See `research/Market analysis.md`"],
    ["a research folder with a space, in quotes", 'See "research/market analysis/results.json"'],
    ["a relative research path with a space, in backticks", "See `../research/Market analysis.md`"],
    ["a relative research path with a space, in quotes", 'See "./research/Market analysis.md"'],
    ["a research path in bold", "See **research/PLAN.md** for the plan"],
    ["a research path in brackets", "[research/G1-SANDBOX-CHECKS.md]"],
    ["a research path in a tight table cell", "|research/PLAN.md|"],
    ["a research path after a flag", "--pairs=research/eval-labels/pairs.csv"],
    ["a research path as an autolink", "<research/PLAN.md>"],
    ["the research folder itself, one level up", "The plan lives in ../research/ next to this repo."],
    ["the research folder itself, in backticks", "See `./research/` for the briefs."],
    ["a research file after a link, in a tight table", "|[CPSC](https://www.cpsc.gov)|[checks](../research/G1-SANDBOX-CHECKS.md)|"],
    ["the research folder after a link, in a tight table", "|[CPSC](https://www.cpsc.gov)|[briefs](../research/)|"],
    ["a private vault", "in the Obsidian vault"],
    ["assistant config", "from .claude/skills/"],
  ])("catches %s in a file's text", (_about, text) => {
    expect(findViolations([file("server/a.ts", text)])).toHaveLength(1);
  });

  it("doesn't mistake a color in CPSC's words for the vault", () => {
    expect(findViolations([file("eval/recalls.json", "sold in Obsidian, Black and Silver")])).toEqual([]);
  });

  it("doesn't mistake an ordinary word for the folder", () => {
    expect(findViolations([file("server/a.ts", "We did our research/review before this. It's a search.")])).toEqual([]);
    expect(findViolations([file("server/a.ts", "That took research/review.")])).toEqual([]);
    expect(findViolations([file("server/a.ts", 'That took "research/review".')])).toEqual([]);
    expect(findViolations([file("server/a.ts", "That took `research/review`.")])).toEqual([]);
  });

  it("leaves a web address alone, even one with a research folder in it", () => {
    expect(findViolations([file("docs/a.md", "See https://example.org/research/report.pdf and https://example.org/research/recalled-products/")])).toEqual([]);
  });

  it("lets .gitignore name what it keeps out", () => {
    expect(findViolations([file(".gitignore", "CLAUDE.local.md\nBUILD-BRIEF*.md\n.claude/skills/\n")])).toEqual([]);
  });
});

describe("judge", () => {
  const bad = ["BUILD-BRIEF.md: shouldn't ship"];

  it("passes while the repo is private, and says what would fail", () => {
    const { code, lines } = judge({ repoPrivate: "true", ci: true, walked: MIN_FILES, violations: bad });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("BUILD-BRIEF.md");
  });

  it("fails the moment the repo is public with anything on the list", () => {
    expect(judge({ repoPrivate: "false", ci: true, walked: MIN_FILES, violations: bad }).code).toBe(1);
  });

  it("passes a clean public repo", () => {
    expect(judge({ repoPrivate: "false", ci: true, walked: MIN_FILES, violations: [] }).code).toBe(0);
  });

  it("fails in CI when it can't tell whether the repo is public", () => {
    expect(judge({ repoPrivate: undefined, ci: true, walked: MIN_FILES, violations: [] }).code).toBe(1);
    expect(judge({ repoPrivate: "", ci: true, walked: MIN_FILES, violations: [] }).code).toBe(1);
  });

  it("doesn't count a file it couldn't read toward the floor", () => {
    expect(judge({ repoPrivate: "false", ci: true, walked: MIN_FILES, unread: 1, violations: [] }).code).toBe(1);
  });

  it("fails in CI on any file it couldn't read, public or private: a clean result wouldn't mean anything", () => {
    const { code, lines } = judge({ repoPrivate: "true", ci: true, walked: MIN_FILES + 5, unread: 1, violations: [] });
    expect(code).toBe(1);
    expect(lines.join(" ")).toContain("couldn't read 1");
  });

  it("allows an unreadable file by hand: a deleted file can still be staged", () => {
    expect(judge({ repoPrivate: undefined, ci: false, walked: MIN_FILES + 5, unread: 1, violations: [] }).code).toBe(0);
  });

  it("only reports when run by hand with no flag", () => {
    expect(judge({ repoPrivate: undefined, ci: false, walked: MIN_FILES, violations: bad }).code).toBe(0);
  });

  it.each(["true", "false"])("fails when it walked too few files to mean anything, private flag %s", (repoPrivate) => {
    expect(judge({ repoPrivate, ci: true, walked: MIN_FILES - 1, violations: [] }).code).toBe(1);
  });

  it("the floor is real: a repo this size clears it and a stray checkout doesn't", () => {
    expect(judge({ repoPrivate: "false", ci: true, walked: plenty.length, violations: findViolations(plenty) }).code).toBe(0);
    expect(judge({ repoPrivate: "false", ci: true, walked: 3, violations: [] }).code).toBe(1);
  });
});
