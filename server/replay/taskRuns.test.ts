import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import { lastTaskRun, recordTaskRun } from "./taskRuns";

const at = (iso: string) => () => new Date(iso);

describe("each run of Replay's refresh task, as the task itself records it", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
  });
  afterEach(async () => {
    await db.close();
  });

  it("is nothing before the task has run", async () => {
    expect(await lastTaskRun(db)).toBeNull();
  });

  it("writes a run that found the numbers fresh, with Render's run id, start and finish", async () => {
    let clock = "2026-11-07T15:51:40.000Z";
    const outcome = await recordTaskRun(db, async () => {
      clock = "2026-11-07T15:51:42.000Z";
      return "FRESH";
    }, { taskRunId: "trn-abc123", now: () => new Date(clock) });
    expect(outcome).toBe("FRESH");
    expect(await lastTaskRun(db)).toEqual({ taskRunId: "trn-abc123", startedAt: "2026-11-07T15:51:40.000Z", finishedAt: "2026-11-07T15:51:42.000Z", outcome: "FRESH" });
  });

  it("writes a failed run as FAILED, and passes the error on so Render retries it", async () => {
    await expect(recordTaskRun(db, async () => Promise.reject(new Error("database went away")), { taskRunId: undefined, now: at("2026-11-07T16:00:00.000Z") })).rejects.toThrow("database went away");
    expect(await lastTaskRun(db)).toMatchObject({ taskRunId: null, outcome: "FAILED", finishedAt: "2026-11-07T16:00:00.000Z" });
  });

  it("says which run is the newest", async () => {
    await recordTaskRun(db, async () => "RAN", { taskRunId: "trn-1", now: at("2026-11-06T22:55:30.000Z") });
    await recordTaskRun(db, async () => "FRESH", { taskRunId: "trn-2", now: at("2026-11-07T15:51:40.000Z") });
    expect(await lastTaskRun(db)).toMatchObject({ taskRunId: "trn-2", outcome: "FRESH" });
  });

  it("keeps the table labelled as the app's own", async () => {
    const { rows } = await db.query<{ comment: string }>("select obj_description('replay_task_runs'::regclass, 'pg_class') as comment");
    expect(rows[0].comment).toBe("data-source: own");
  });
});
