-- Years inside a run's dates that didn't load, so "2022 to 2026" can't hide a gap in the middle.
alter table shop_runs add column recall_years_missing integer[] not null default '{}';
