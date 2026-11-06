-- A run says which years of recalls hadn't loaded when it ran, so "every recall" is never said over a gap.
alter table replay_runs add column recall_years_missing integer[] not null default '{}';
