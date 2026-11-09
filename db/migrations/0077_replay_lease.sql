-- One row: who is refreshing Replay right now. The daily task and the web service's fallback both refresh it, and the lease
-- lets only one do the work at a time. A run takes seconds; the lease outlasts the task's 30-minute limit, so a live run
-- can't lose it, and one a crashed run leaves behind lapses on its own. Only the claim that took it can hand it back.
create table replay_lease (
  id      smallint primary key check (id = 1),
  holder  uuid not null,
  until   timestamptz not null
);
comment on table replay_lease is 'data-source: own';
