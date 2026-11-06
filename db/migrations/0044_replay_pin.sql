-- The filmed run stays, so the film and write-up can be checked against it after newer runs have pruned the rest.
alter table replay_runs add column pinned boolean not null default false;
