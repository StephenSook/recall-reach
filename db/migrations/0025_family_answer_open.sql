-- True only after a family said "not sure", which they can still follow with a real answer. Any other
-- recorded result is final, so a later post on the link cannot change what the seller sees.
alter table notices add column check_open boolean not null default false;
