-- Recall Replay: every recall loaded, checked in one run against the demo catalog. The rows hold CPSC's words and the
-- demo shop's. Nothing from PayPal is kept but how much of its history the run could read, and a count.
create table replay_runs (
  id               uuid primary key default gen_random_uuid(),
  ms               integer not null,
  checked          integer not null,
  matched          integer not null,
  scope_gaps       integer not null,
  cleared          integer not null,
  not_near         integer not null,
  notice_only      integer not null,
  refund_eligible  integer not null,
  unidentified     integer not null,
  search_windows   integer not null,
  failed_windows   integer not null,
  search_complete  boolean not null,
  recalls_digest   text not null, -- which CPSC records this run read
  created_at       timestamptz not null default now()
);
comment on table replay_runs is 'data-source: own';

create table replay_rows (
  run_id         uuid not null references replay_runs (id) on delete cascade,
  recall_number  text not null,
  recall_title   text not null,
  recall_date    date not null,
  outcome        text not null check (outcome in ('MATCH', 'SCOPE_GAP', 'CLEARED', 'NOT_NEAR')),
  sale_split     text check (sale_split in ('NOTICE_ONLY', 'REVIEW', 'REFUND_ELIGIBLE')),
  item_title     text,
  reason         text,
  primary key (run_id, recall_number)
);
comment on table replay_rows is 'data-source: shop-owned';
