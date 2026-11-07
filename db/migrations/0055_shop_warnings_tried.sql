-- When a shop's warning check last began, so one that keeps failing goes to the back and can't hold up the rest.
alter table shops add column warnings_tried_at timestamptz;
