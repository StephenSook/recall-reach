-- What a search of the wider market found for a recall's product name, cached so that reading it never calls anyone.
-- Titles and brands only. Offers are dropped on arrival, so no retailer is kept, and none can be named.
create table recall_sweeps (
  recall_id      integer primary key references recalls (recall_id) on delete cascade,
  recall_sha256  text not null,
  query          text not null,
  status         text not null check (status in ('ok', 'failed')),
  listings       jsonb not null default '[]',
  index_as_of    timestamptz,
  searched_at    timestamptz not null default now()
);
comment on table recall_sweeps is 'data-source: channel3';
