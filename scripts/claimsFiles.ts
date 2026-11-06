import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { Files } from "./claims";

const PAGE = /^(README\.md$|openapi\.yaml$|app\/.*\.(ts|tsx)$)/;
const TEST = /\.test\.tsx?$/;

export function readRepo(): Files {
  return {
    read: (file) => (existsSync(file) ? readFileSync(file, "utf8") : null),
    // Untracked files too, so a new page is checked before it is committed.
    readable: () =>
      execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" })
        .split("\0")
        .filter((f) => PAGE.test(f) && !TEST.test(f) && existsSync(f)),
  };
}
