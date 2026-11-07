// The last step after APIMatic generates the SDK and the docs portal. Its templates write dashes and curly quotes, which
// our own writing doesn't use. In prose a dash between words becomes a comma. In a script or a style sheet a character
// left over becomes its escape, which is the same character to the code, so nothing it does can change.
//   pnpm exec tsx scripts/apimatic-tidy.ts sdk/typescript public/api-docs
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

const BANNED = /[\u2013\u2014\u2018\u2019\u201c\u201d]/g;
/** A dash with words on both sides: "referenced, run". A dash alone in a table cell is a minus, not a pause. */
const BETWEEN_WORDS = /(?<=[\p{L}\p{N}`)\]*_]) +\u2014 +(?=[\p{L}\p{N}`(\[*_])/gu;
const PLAIN: Record<string, string> = { "\u2013": "-", "\u2014": "-", "\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"' };
const TEXT = new Set([".md", ".mdx", ".txt", ".html", ".xml", ".ts", ".json", ".js", ".mjs", ".css", ".map"]);

const hex = (ch: string) => ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0");

export function tidy(text: string, ext: string): string {
  const prose = text.replace(BETWEEN_WORDS, ", ");
  if (ext === ".js" || ext === ".mjs" || ext === ".map") return prose.replace(BANNED, (ch) => `\\u${hex(ch)}`);
  if (ext === ".css") return prose.replace(BANNED, (ch) => `\\${hex(ch)}`);
  // In JSON a straight double quote would end the string it's in.
  if (ext === ".json") return prose.replace(BANNED, (ch) => (ch === "\u201c" || ch === "\u201d" ? '\\"' : PLAIN[ch]));
  return prose.replace(BANNED, (ch) => PLAIN[ch]);
}

function walk(dir: string, changed: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".tshy") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, changed);
    else if (TEXT.has(extname(name))) {
      const before = readFileSync(path, "utf8");
      const after = tidy(before, extname(name));
      if (after !== before) {
        writeFileSync(path, after);
        changed.push(path);
      }
    }
  }
}

if (process.argv[1]?.endsWith("apimatic-tidy.ts")) {
  const changed: string[] = [];
  for (const dir of process.argv.slice(2)) walk(dir, changed);
  console.log(`tidied ${changed.length} files`);
}
