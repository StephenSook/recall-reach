import { readFileSync } from "node:fs";

export const MIN_REQUESTS = 10;
export const MIN_ASSERTIONS = 26;

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
}

function countsFrom(report: unknown) {
  const run = field(report, "run");
  const stats = field(run, "stats");
  const requests = field(stats, "requests");
  const assertions = field(stats, "assertions");
  const executions = field(run, "executions");
  return {
    "run.stats.requests.total": field(requests, "total"),
    "run.stats.requests.failed": field(requests, "failed"),
    "run.stats.assertions.total": field(assertions, "total"),
    "run.stats.assertions.failed": field(assertions, "failed"),
    "run.executions.length": Array.isArray(executions) ? executions.length : undefined,
  };
}

export function checkNewman(report: unknown): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const counts = countsFrom(report);
  for (const [name, count] of Object.entries(counts)) {
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      reasons.push(`${name} is missing or invalid: expected a non-negative integer`);
      continue;
    }
    const minimum = name === "run.stats.assertions.total" ? MIN_ASSERTIONS : MIN_REQUESTS;
    if (name.endsWith(".failed")) {
      if (count !== 0) reasons.push(`${name} must be 0, found ${count}`);
    } else if (count < minimum) {
      reasons.push(`${name} must be at least ${minimum}, found ${count}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

if (process.argv[1]?.endsWith("newman-floor.ts")) {
  let report: unknown;
  try {
    const path = process.argv[2];
    if (!path) throw new Error("usage: newman-floor.ts <report.json>");
    report = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`cannot read Newman report: ${err instanceof Error ? err.message : "unknown error"}`);
    process.exitCode = 1;
  }
  console.log(`Newman counts: ${Object.entries(countsFrom(report)).map(([name, count]) => `${name}=${count === undefined ? "missing" : String(count)}`).join(", ")}`);
  const result = checkNewman(report);
  for (const reason of result.reasons) console.error(reason);
  if (!result.ok) process.exitCode = 1;
}
