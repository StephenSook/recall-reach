-- How many checks came in through the public API and the MCP tool, per day. Only counts: never the text anyone sent.
create table public_calls (
  day      date not null,
  surface  text not null check (surface in ('api', 'mcp')),
  calls    integer not null default 0,
  primary key (day, surface)
);
comment on table public_calls is 'data-source: own';
