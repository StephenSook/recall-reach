// The repo goes public, and that flip is one click. In CI this reads GitHub's own flag: it passes while the repo is
// private, naming what would fail, and fails once the repo is public with any of it still here. It holds the words it
// looks for, so it leaves itself out of the walk by pathspec. It imports only Node, so it runs with no install.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Tracked files on Nov 10, 2026: 917. A walk far below this saw a wrong or shallow checkout, and "clean" would mean nothing. */
export const MIN_FILES = 250;

const SHOULD_NOT_SHIP = [/(^|\/)BUILD-BRIEF/i, /(^|\/)CLAUDE\.local/i, /(^|\/)research\//, /(^|\/)\.claude\//, /(^|\/)\.env(?!\.example$)/, /\.(pem|key|p12)$/, /^test-results\//, /^playwright-report\//, /^\.next\//];
// Anyone's home directory, with or without a path after it, written with /, \ or JSON's \/. A local path shouldn't ship,
// and naming one account here would ship that name. Not inside an http(s) web address, which ends at a space, ) ] | > a quote,
// or a shell's ; or &, but a file:// link still counts. Backslashes may be doubled, as JSON writes them, and a name may be
// percent-encoded, as in a file URL.
const PRIVATE_WORDS = [/(?<!https?:\/\/[^\s)\]|>"'`;&]*)(?:\\{1,2}|\\?\/)(?:Users|home)(?:\\{1,2}|\\?\/)[\w.%-]+/, /BUILD-BRIEF/, /CLAUDE\.local/, // Not glued to a word before it, and not inside a web address, which ends at a space or at ) ] | > or a quote.
  // "./" and "../" segments after the folder still lead into it: "research/./PLAN.md".
  /(?<!:\/\/[^\s)\]|>"'`]*)(?<![\w-])research\/(?:\.{1,2}\/)*(?:\.?[\w-]+(?:\.[\w-]+)*\/(?:[\w./-]*[\w-])?|\.?[\w-]+\.\w+|\.[\w-]+)/,
  // The folder itself, named as a relative path: "../research/". A bare "research/" is too like prose to count.
  /(?<!:\/\/[^\s)\]|>"'`]*)(?<![\w.-])\.{1,2}\/research\/(?![\w.-])/,
  // Inside backticks or quotes a path can hold spaces: "research/Market analysis.md". It still needs a path's shape, a file
  // extension or a second folder, so quoted prose like "research/review" passes.
  /[`"'](?:\.{1,2}\/)*research\/[^`"'\n/]*?(?:\/[^`"'\n]*|\.\w+)[`"']/, /Obsidian (?:vault|note)/i, /\.claude\//];
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

export function judge(input: { repoPrivate: string | undefined; ci: boolean; walked: number; unread?: number; violations: string[] }): { code: number; lines: string[] } {
  const named = input.violations.map((v) => `  ${v}`);
  const unread = input.unread ?? 0;
  if (input.ci && unread > 0) return { code: 1, lines: [`couldn't read ${unread} files, so a clean result would mean nothing`] };
  if (input.walked - unread < MIN_FILES) return { code: 1, lines: [`walked only ${input.walked} files, under the floor of ${MIN_FILES}, so a clean result would mean nothing`] };
  if (input.repoPrivate === "false") {
    return input.violations.length === 0
      ? { code: 0, lines: [`public, and clean across ${input.walked} files`] }
      : { code: 1, lines: ["the repo is public and still holds:", ...named] };
  }
  if (input.repoPrivate === "true") return { code: 0, lines: [`private, ${input.walked} files walked. Would fail if public on ${input.violations.length}:`, ...named] };
  if (input.ci) return { code: 1, lines: ["CI gave no visibility flag, so this can't tell whether the repo is public"] };
  return { code: 0, lines: [`run by hand, so only reporting. ${input.walked} files walked, ${input.violations.length} would fail:`, ...named] };
}

function walk(): { path: string; text: string; unread?: boolean }[] {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ".", ...OWN_PATHS.map((p) => `:(exclude)${p}`)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return listed
    .split("\0")
    .filter(Boolean)
    .map((path) => {
      try {
        const text = readFileSync(path, "utf8");
        return { path, text: text.includes("\0") ? "" : text };
      } catch {
        return { path, text: "", unread: true }; // its name is still checked
      }
    });
}

if (process.argv[1]?.endsWith("publicGuard.ts")) {
  const files = walk();
  const { code, lines } = judge({ repoPrivate: process.env.REPO_PRIVATE, ci: process.env.CI === "true", walked: files.length, unread: files.filter((f) => f.unread).length, violations: findViolations(files) });
  for (const line of lines) console.log(line);
  process.exitCode = code;
}
