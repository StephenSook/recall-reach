-- Each run of Replay's refresh task, written by the task itself, including the runs that find the numbers fresh and do
-- nothing. So one start of the task can be seen to have run from this database, without reading the host's logs.
create table replay_task_runs (
  id           bigserial primary key,
  task_run_id  text, -- the host's id for this run, when it passes one
  started_at   timestamptz not null,
  finished_at  timestamptz,
  outcome      text check (outcome in ('FRESH', 'RAN', 'DISCARDED', 'FAILED'))
);
create index replay_task_runs_started_at_idx on replay_task_runs (started_at);
comment on table replay_task_runs is 'data-source: own';
