import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import { appJobs, CPSC_POLL_MS, PURGE_MS } from "./appJobs";

const fixture: { RecallID: number; LastPublishDate: string }[] = JSON.parse(
  readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8"),
);

describe("appJobs", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
  });

  it("polls CPSC and purges PayPal data every 15 minutes", () => {
    const jobs = appJobs(db);
    expect(jobs.map((j) => [j.name, j.everyMs])).toEqual([
      ["cpsc-poll", CPSC_POLL_MS],
      ["paypal-48h-purge", PURGE_MS],
    ]);
    expect(CPSC_POLL_MS).toBe(15 * 60_000);
    expect(PURGE_MS).toBe(15 * 60_000);
  });

  it("cpsc-poll pulls recalls published yesterday and today, and logs the pull", async () => {
    const requested: string[] = [];
    // CPSC answers with the recalls last published on Nov 5, 2026.
    const nov5 = fixture.filter((r) => r.LastPublishDate.startsWith("2026-11-05"));
    const fetchImpl = async (url: string | URL | Request) => {
      requested.push(String(url));
      return new Response(JSON.stringify(nov5), { status: 200, headers: { "content-type": "application/json" } });
    };
    const [poll] = appJobs(db, { fetchImpl: fetchImpl as typeof fetch, now: () => new Date("2026-11-05T22:00:00Z") });
    await poll.run();
    expect(new URL(requested[0]).searchParams.get("LastPublishDateStart")).toBe("2026-11-04");
    expect(new URL(requested[0]).searchParams.get("LastPublishDateEnd")).toBe("2026-11-05");
    const { rows } = await db.query<{ n: string }>("select count(*)::text as n from recalls");
    expect(Number(rows[0].n)).toBe(nov5.length);
    expect(nov5.length).toBeGreaterThan(0);
  });

  it("paypal-48h-purge deletes PayPal-sourced rows older than 48 hours", async () => {
    await db.query(
      `insert into paypal_webhook_events (event_id_hmac, event_type, verification_method, received_at)
       values ('old', 'T', 'self', now() - interval '3 days'), ('new', 'T', 'self', now())`,
    );
    const [, purge] = appJobs(db);
    await purge.run();
    const { rows } = await db.query<{ event_id_hmac: string }>("select event_id_hmac from paypal_webhook_events");
    expect(rows.map((r) => r.event_id_hmac)).toEqual(["new"]);
  });
});
