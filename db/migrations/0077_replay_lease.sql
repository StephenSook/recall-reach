-- One row: who is refreshing Replay right now. The daily task and the web service's fallback both refresh it, and the lease
-- lets only one do the work at a time. A run takes seconds; a lease left by a crashed run lapses after ten minutes.
create table replay_lease (
  id     smallint primary key check (id = 1),
  until  timestamptz not null
);
comment on table replay_lease is 'data-source: own';
