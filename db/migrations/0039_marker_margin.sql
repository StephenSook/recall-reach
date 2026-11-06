-- A recall's first_seen_at is when its load began, and that load can commit after a new shop's first check has read the
-- table. So a new shop starts its marker a little before it was made. Checking a recall twice adds nothing.
alter table shops alter column recalls_checked_through set default now() - interval '5 minutes';
