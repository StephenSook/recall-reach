-- How far a shop has been checked against recalls, compared with recalls.first_seen_at. It moves in the same
-- transaction as the check it records, so a failed check leaves the shop to be tried again with nothing half done.
alter table shops add column recalls_checked_through timestamptz not null default now();
