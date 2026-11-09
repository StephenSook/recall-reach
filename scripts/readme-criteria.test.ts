import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const heading = "## How this meets the judging criteria";
const readme = readFileSync(resolve(root, "README.md"), "utf8");
const section = readme.split(`${heading}\n`)[1]?.split(/^## /m)[0] ?? "";
const table = section.split("\n").filter((line) => line.startsWith("|"));
const cells = (line: string) => line.slice(1, -1).split("|").map((cell) => cell.trim());
const rows = table.slice(2).map(cells);
const criteria = ["Technological Implementation", "Design", "Potential Impact", "Innovation/Idea", "Presentation"];
const sponsors = ["AG Grid", "APIMatic", "Bryntum", "Channel3", "Postman", "Render"];
const link = /\[[^\n]*?\]\(([^)\s]+)\)/g;
const targets = (text: string) => [...text.matchAll(link)].map((match) => match[1]);
const references = rows.flatMap((row) => row.flatMap(targets));
const site = "https://recall-reach-web-e022.onrender.com";
const routes = readdirSync(resolve(root, "app"), { recursive: true })
  .filter((file) => /(?:^|\/)(?:page\.tsx|route\.ts)$/.test(file))
  .map((file) => dirname(file).split(sep).filter((part) => part !== "."));

describe("the README judging criteria table", () => {
  it("names every criterion exactly and gives each sponsor a row", () => {
    expect(readme.split(heading)).toHaveLength(2);
    expect(cells(table[0] ?? "")).toEqual(["Criterion", "Open this", "What it shows", "In the code"]);
    expect(rows.length).toBeGreaterThanOrEqual(5 + 6);
    expect([...new Set(rows.map((row) => row[0]))].sort()).toEqual([...criteria, ...sponsors].sort());
    for (const name of criteria) {
      const count = rows.filter((row) => row[0] === name).length;
      expect(count, name).toBeGreaterThanOrEqual(2);
      expect(count, name).toBeLessThanOrEqual(4);
    }
    for (const name of sponsors) expect(rows.filter((row) => row[0] === name), name).toHaveLength(1);
    for (const row of rows) {
      expect(row).toHaveLength(4);
      expect(targets(row[1]), row[1]).toHaveLength(1);
      expect(targets(row[3]).length, row[3]).toBeGreaterThanOrEqual(1);
      expect(targets(row[3]).length, row[3]).toBeLessThanOrEqual(2);
      // These cells hold links, so an unlinked path cannot escape the file checks.
      for (const cell of [row[1], row[3]]) expect(cell.replaceAll(link, "").replaceAll(",", "").trim(), cell).toBe("");
      for (const path of targets(row[3])) expect(path, row[3]).not.toMatch(/^https?:|^\//);
    }
  });

  it("points every repository link at a file that exists", () => {
    const files = references.filter((target) => !target.startsWith("https://"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const path = resolve(root, file);
      expect(existsSync(path), `Missing repository file: ${file}`).toBe(true);
      expect(statSync(path).isFile(), `Not a repository file: ${file}`).toBe(true);
    }
  });

  it("maps every site link to an App Router page or route handler", () => {
    const urls = references.filter((target) => target.startsWith("https://"));
    expect(urls.length).toBeGreaterThan(0);
    for (const target of urls) {
      const url = new URL(target);
      expect(url.origin, target).toBe(site);
      const parts = decodeURIComponent(url.pathname).split("/").filter(Boolean);
      const found = routes.some((route) => route.length === parts.length && route.every((part, i) => part === parts[i] || /^\[[^/\]]+\]$/.test(part)));
      expect(found, `No App Router page or route handler: ${url.pathname}`).toBe(true);
    }
  });
});
