-- Candidates the per-recall cap left unchecked. A run reports this rather than staying quiet about it.
alter table shop_runs add column candidates_not_checked integer not null default 0;
