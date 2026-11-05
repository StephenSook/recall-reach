// Loads whole years of real CPSC recalls into DATABASE_URL.
// Usage: pnpm load:recalls            (2025 and 2026)
//        pnpm load:recalls 2024 2025  (any years)
// Exits non-zero if any pull failed or reported invalid records.
import { loadYears } from "../server/cpsc/load";
import { migrate } from "../server/db/migrate";
import { closeDb, getDb } from "../server/db/pg";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const years = args.length > 0 ? args.map(Number) : [2025, 2026];
  if (years.some((y) => !Number.isInteger(y) || y < 1970)) throw new Error(`not a year list: ${args.join(" ")}`);

  const db = getDb();
  await migrate(db);
  const today = new Date().toISOString().slice(0, 10);
  const { pulls, countsByYear } = await loadYears(db, years, today);

  for (const p of pulls) {
    console.log(
      `pull ${p.pullId} ${p.range.start}..${p.range.end}: ${p.status}, fetched ${p.fetched}, ` +
        `inserted ${p.inserted}, updated ${p.updated}, unchanged ${p.unchanged}, invalid ${p.invalid.length}`,
    );
    for (const bad of p.invalid) console.log(`  invalid #${bad.index} (RecallID ${bad.recallId}): ${bad.issues.join("; ")}`);
  }
  for (const year of years) console.log(`recalls stored for ${year}: ${countsByYear[year] ?? 0}`);
  if (pulls.some((p) => p.status !== "ok")) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
