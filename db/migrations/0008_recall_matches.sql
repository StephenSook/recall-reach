create extension if not exists pg_trgm;

-- What PayPal returned about a shop's orders. Local use only, never sent to a third party, and
-- deleted by the 46-hour purge (server/privacy/retention.ts). Older facts are re-read from PayPal.
create table paypal_payments (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references shops (id) on delete cascade,
  order_id        text not null,
  order_number    text, -- the shop's number, from invoice_id or custom_id
  capture_id      text,
  capture_status  text,
  captured_at     timestamptz,
  amount_cents    integer,
  currency        text,
  items           jsonb not null default '[]',
  received_at     timestamptz not null default now(),
  unique (shop_id, order_id)
);
create index paypal_payments_received_at_idx on paypal_payments (received_at);
comment on table paypal_payments is 'data-source: paypal';

-- This app's own decisions: one row per recall and shop record it was checked against.
create table recall_matches (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references shops (id) on delete cascade,
  recall_id      integer not null references recalls (recall_id),
  recall_sha256  text not null, -- the exact CPSC snapshot this decision read
  order_line_id  uuid references order_lines (id) on delete cascade,
  shop_item_id   uuid references shop_items (id) on delete cascade,
  verdict        text not null check (verdict in ('MATCH', 'SCOPE_GAP', 'CLEARED')),
  matched        jsonb not null,
  missing        jsonb not null,
  reason         text not null,
  sale_path      text check (sale_path in ('NOTICE_ONLY', 'REVIEW', 'REFUND_ELIGIBLE')),
  join_state     text check (join_state in ('IDENTIFIED', 'AMBIGUOUS_JOIN', 'HISTORY_UNAVAILABLE', 'NO_PAYPAL_RECORD')),
  checked_at     timestamptz not null default now(),
  check ((order_line_id is null) <> (shop_item_id is null))
);
create unique index recall_matches_one_per_record_idx
  on recall_matches (shop_id, recall_id, coalesce(order_line_id, shop_item_id));
comment on table recall_matches is 'data-source: own';

-- Every run says what it covered, so "nothing found" is never a false all-clear.
create table shop_runs (
  id                    uuid primary key default gen_random_uuid(),
  shop_id               uuid not null references shops (id) on delete cascade,
  recalls_checked       integer not null,
  matches               integer not null,
  scope_gaps            integer not null,
  cleared               integer not null,
  searched_from         date,
  searched_to           date not null,
  unidentified_payments integer not null,
  finished_at           timestamptz not null default now()
);
comment on table shop_runs is 'data-source: own';
