-- An approval is for one exact version of the order line. Re-importing the line keeps its id, so the
-- id alone cannot tell. Approvals from before this column have none, match nothing, and expire on their own.
alter table approvals add column line_sha256 text;
