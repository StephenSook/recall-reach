-- The latest runs of the safety checks, so the page can show one without running anything. The checks run on throwaway
-- shops that are deleted afterwards. The results hold only what was tried and what stopped it.
create table safety_runs (
  id       uuid primary key default gen_random_uuid(),
  ran_at   timestamptz not null default now(),
  ms       integer not null,
  results  jsonb not null
);
comment on table safety_runs is 'data-source: own';
