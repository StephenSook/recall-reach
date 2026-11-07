-- A separate sandbox payment an owner can choose to send for a sale past PayPal's 180-day refund window. Approved twice, for
-- one exact amount, only to an email the owner typed. Our ledger: the email encrypted, and PayPal's ids only as a keyed hash.
create table payouts (
  id                uuid primary key default gen_random_uuid(),
  shop_id           uuid not null references shops (id) on delete cascade,
  session_id        text not null,
  sample_key        text not null,
  receiver_enc      text not null,
  amount_cents      integer not null check (amount_cents > 0),
  currency          text not null,
  request_id        uuid not null unique default gen_random_uuid(),
  status            text not null check (status in ('reviewed', 'sending', 'unconfirmed', 'paid', 'unclaimed', 'failed')),
  paypal_status     text,
  batch_ref_hmac    text,
  expires_at        timestamptz not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (shop_id, sample_key)
);
comment on table payouts is 'data-source: own';

-- The raw id needed to read a payout back. PayPal data: gone after the 46-hour purge, like refund references.
create table paypal_payout_refs (
  payout_row_id  uuid primary key references payouts (id) on delete cascade,
  batch_id       text not null,
  received_at    timestamptz not null default now()
);
create index paypal_payout_refs_received_at_idx on paypal_payout_refs (received_at);
comment on table paypal_payout_refs is 'data-source: paypal';
