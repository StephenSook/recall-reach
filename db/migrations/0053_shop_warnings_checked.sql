-- So a pass over stored shops that runs out of time picks up where it stopped.
alter table shops add column warnings_checked_at timestamptz;
