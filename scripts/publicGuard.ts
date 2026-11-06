// The repo goes public, and that flip is one click. In CI this reads GitHub's own flag: it passes while the repo is
// private, naming what would fail, and fails once the repo is public with any of it still here. It holds the words it
// looks for, so it leaves itself out of the walk by pathspec. It imports only Node, so it runs with no install.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Tracked files today: 318. A walk far below this saw a wrong or shallow checkout, and "clean" would mean nothing. */
export const MIN_FILES = 250;

const SHOULD_NOT_SHIP = [/^BUILD-BRIEF/i, /^CLAUDE\.local/i, /^research\//, /(^|\/)\.claude\//, /(^|\/)\.env(?!\.example$)/, /\.(pem|key|p12)$/, /^test-results\//, /^playwright-report\//, /^\.next\//];
const PRIVATE_WORDS = [/\/Users\/stephensookra/, /BUILD-BRIEF/, /CLAUDE\.local/, /(?:^|[\s("'`./])research\/[A-Za-z_-]+\.(?:md|csv|json|pdf)/, /Obsidian (?:vault|note)/i, /\.claude\//];
/** Its job is to name what it keeps out. */
const MAY_NAME_THEM = new Set([".gitignore"]);
const OWN_PATHS = ["scripts/publicGuard.ts", "scripts/publicGuard.test.ts"];

export function findViolations(files: { path: string; text: string }[]): string[] {
  const found: string[] = [];
  for (const { path, text } of files) {
    if (SHOULD_NOT_SHIP.some((p) => p.test(path))) {
      found.push(`${path}: shouldn't ship`);
      continue;
    }
    if (MAY_NAME_THEM.has(path)) continue;
    const word = PRIVATE_WORDS.find((p) => p.test(text));
    if (word) found.push(`${path}: holds "${word.exec(text)?.[0].trim()}"`);
  }
  return found;
}

export function judge(input: { repoPrivate: string | undefined; ci: boolean; walked: number; violations: string[] }): { code: number; lines: string[] } {
  const named = input.violations.map((v) => `  ${v}`);
  if (input.walked < MIN_FILES) return { code: 1, lines: [`walked only ${input.walked} files, under the floor of ${MIN_FILES}, so a clean result would mean nothing`] };
  if (input.repoPrivate === "false") {
    return input.violations.length === 0
      ? { code: 0, lines: [`public, and clean across ${input.walked} files`] }
      : { code: 1, lines: ["the repo is public and still holds:", ...named] };
  }
  if (input.repoPrivate === "true") return { code: 0, lines: [`private, ${input.walked} files walked. Would fail if public on ${input.violations.length}:`, ...named] };
  if (input.ci) return { code: 1, lines: ["CI gave no visibility flag, so this can't tell whether the repo is public"] };
  return { code: 0, lines: [`run by hand, so only reporting. ${input.walked} files walked, ${input.violations.length} would fail:`, ...named] };
}

function walk(): { path: string; text: string }[] {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ".", ...OWN_PATHS.map((p) => `:(exclude)${p}`)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return listed
    .split("\0")
    .filter(Boolean)
    .map((path) => {
      try {
        const text = readFileSync(path, "utf8");
        return { path, text: text.includes("\0") ? "" : text };
      } catch {
        return { path, text: "" }; // deleted but still staged: its name is what's left to check
      }
    });
}

if (process.argv[1]?.endsWith("publicGuard.ts")) {
  const files = walk();
  const { code, lines } = judge({ repoPrivate: process.env.REPO_PRIVATE, ci: process.env.CI === "true", walked: files.length, violations: findViolations(files) });
  for (const line of lines) console.log(line);
  process.exitCode = code;
}
