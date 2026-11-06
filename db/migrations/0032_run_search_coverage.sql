-- What a run's search of PayPal really covered, so the screen can say exactly that.
alter table shop_runs add column search_windows integer not null default 0;
alter table shop_runs add column failed_windows integer not null default 0;
alter table shop_runs add column rows_read integer not null default 0;
