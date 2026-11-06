import { describe, expect, it } from "vitest";
import { findViolations, judge, MIN_FILES } from "./publicGuard";

const file = (path: string, text = "ordinary words") => ({ path, text });
const plenty = Array.from({ length: MIN_FILES }, (_, i) => file(`server/file${i}.ts`));

describe("findViolations", () => {
  it.each(["BUILD-BRIEF.md", "BUILD-BRIEF-4.md", "CLAUDE.local.md", "research/PLAN.md", "research/film/take.mp4", ".claude/settings.local.json", ".env", ".env.local", "deploy/.env.production", "server.pem", "keys/id.key", "test-results/out.png", "playwright-report/index.html", ".next/trace"])(
    "catches the file %s",
    (path) => {
      expect(findViolations([file(path)])).toEqual([`${path}: shouldn't ship`]);
    },
  );

  it.each(["README.md", ".env.example", "server/research.ts", "docs/replay/run.json", "app/env.ts", "CLAUDE.md.txt"])("leaves %s alone", (path) => {
    expect(findViolations([file(path)])).toEqual([]);
  });

  it.each([
    ["a home directory", "see /Users/stephensookra/dev/notes"],
    ["a private brief", "as BUILD-BRIEF-3 says"],
    ["local instructions", "see CLAUDE.local for this"],
    ["the research folder", "wording from research/COPY-DECK.md"],
    ["the research folder, one level up", "read ../research/PLAN.md"],
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
