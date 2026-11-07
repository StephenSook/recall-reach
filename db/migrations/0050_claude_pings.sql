-- When Claude last answered the daily call, so a spent balance doesn't stay green. Only a time: the call carries no data.
create table claude_pings (
  only_row    boolean primary key default true check (only_row),
  last_ok_at  timestamptz not null
);
comment on table claude_pings is 'data-source: own';
