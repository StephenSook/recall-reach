-- A question that went out, on a sale later confirmed, is followed by a safety notice, and stays on record as
-- it was. So a match can have one message of each kind.
alter table notices drop constraint notices_match_id_key;
create unique index notices_one_of_each_kind on notices (match_id, kind);
