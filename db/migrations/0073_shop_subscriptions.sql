-- A billing relationship never controls recall checks, notices, receipts or refunds.
-- The HMAC and our request/closed markers stay with the shop; PayPal facts are cleared at 46 hours.
create table shop_subscriptions (
  shop_id uuid primary key references shops (id) on delete cascade,
  request_id uuid not null default gen_random_uuid(),
  requested_at timestamptz not null default now(),
  subscription_id_hmac text unique,
  plan_id text not null,
  status text check (status in ('APPROVAL_PENDING', 'APPROVED', 'ACTIVE', 'SUSPENDED', 'CANCELLED', 'EXPIRED')),
  started_at timestamptz,
  closed boolean not null default false,
  updated_at timestamptz not null default now()
);
comment on table shop_subscriptions is 'data-source: paypal-hmac';

-- Reversible id needed for reads/cancellation, sealed at rest, never shown or logged, purged hourly.
create table paypal_subscription_refs (
  shop_id uuid primary key references shop_subscriptions (shop_id) on delete cascade,
  subscription_id_sealed text not null,
  received_at timestamptz not null default now()
);
comment on table paypal_subscription_refs is 'data-source: paypal';
