-- A human approval for one exact action. Bound to shop, session, recall version, order line, amount
-- and currency; short-lived; consumed once, atomically, by the refund it authorizes.
create table approvals (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references shops (id) on delete cascade,
  session_id     text not null,
  recall_id      integer not null references recalls (recall_id),
  recall_sha256  text not null,
  order_line_id  uuid not null references order_lines (id) on delete cascade,
  amount_cents   integer not null check (amount_cents > 0),
  currency       text not null,
  expires_at     timestamptz not null,
  consumed_at    timestamptz,
  created_at     timestamptz not null default now()
);
comment on table approvals is 'data-source: own';

-- Our ledger of refunds. No raw PayPal ids: refund_ref_hmac is an HMAC that webhook rows can be joined on.
create table refunds (
  id               uuid primary key default gen_random_uuid(),
  approval_id      uuid not null unique references approvals (id) on delete cascade,
  shop_id          uuid not null references shops (id) on delete cascade,
  order_line_id    uuid not null references order_lines (id) on delete cascade,
  request_id       uuid not null unique default gen_random_uuid(), -- PayPal-Request-Id: one refund however often it is sent
  amount_cents     integer not null,
  currency         text not null,
  status           text not null check (status in ('pending', 'refunded', 'failed', 'unconfirmed')),
  failure          text, -- PayPal's issue code, or why it could not be confirmed
  refund_ref_hmac  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index refunds_shop_idx on refunds (shop_id);
create index refunds_line_idx on refunds (order_line_id);
comment on table refunds is 'data-source: own';

-- The raw ids needed to read the refund back from PayPal. PayPal data: gone after the 46-hour purge.
create table paypal_refund_refs (
  refund_row_id  uuid primary key references refunds (id) on delete cascade,
  capture_id     text not null,
  refund_id      text,
  received_at    timestamptz not null default now()
);
create index paypal_refund_refs_received_at_idx on paypal_refund_refs (received_at);
comment on table paypal_refund_refs is 'data-source: paypal';
