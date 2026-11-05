// Applies pending migrations in db/migrations to DATABASE_URL.  Usage: pnpm db:migrate
import { migrate } from "../server/db/migrate";
import { closeDb, getDb } from "../server/db/pg";

async function main(): Promise<void> {
  const applied = await migrate(getDb());
  console.log(applied.length > 0 ? `applied: ${applied.join(", ")}` : "database is up to date");
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
