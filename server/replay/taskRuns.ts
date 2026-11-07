// Each run of Replay's refresh task, as the task records it: when it started, when it finished, and what it did. It writes
// a row even when the numbers were fresh and it did nothing, so a single start shows in this database that it really ran.
import type { Queryable } from "../db/types";

export type TaskOutcome = "FRESH" | "RAN" | "DISCARDED";

export interface TaskRun {
  taskRunId: string | null;
  startedAt: string;
  finishedAt: string | null;
  outcome: TaskOutcome | "FAILED" | null;
}

/** Runs the task's work between a start row and a finish row. A failure is written as FAILED and thrown on, so the host retries. */
export async function recordTaskRun(db: Queryable, work: () => Promise<TaskOutcome>, input: { taskRunId: string | undefined; now: () => Date }): Promise<TaskOutcome> {
  const { rows } = await db.query<{ id: string }>("insert into replay_task_runs (task_run_id, started_at) values ($1, $2) returning id::text", [input.taskRunId ?? null, input.now().toISOString()]);
  const finish = (outcome: string) => db.query("update replay_task_runs set finished_at = $2, outcome = $3 where id = $1::bigint", [rows[0].id, input.now().toISOString(), outcome]);
  let outcome: TaskOutcome;
  try {
    outcome = await work();
  } catch (err) {
    await finish("FAILED");
    throw err;
  }
  await finish(outcome);
  return outcome;
}

const iso = (value: unknown): string | null => (value === null || value === undefined ? null : new Date(value as string).toISOString());

export async function lastTaskRun(db: Queryable): Promise<TaskRun | null> {
  const { rows } = await db.query<{ task_run_id: string | null; started_at: unknown; finished_at: unknown; outcome: TaskRun["outcome"] }>(
    "select task_run_id, started_at, finished_at, outcome from replay_task_runs order by started_at desc, id desc limit 1",
  );
  const row = rows[0];
  if (!row) return null;
  return { taskRunId: row.task_run_id, startedAt: iso(row.started_at) as string, finishedAt: iso(row.finished_at), outcome: row.outcome };
}
