-- A phone that asked to buzz when a card lands on this shop's queue. It goes when the shop goes.
create table push_tokens (
  shop_id     uuid not null references shops (id) on delete cascade,
  token       text not null,
  created_at  timestamptz not null default now(),
  primary key (shop_id, token)
);
comment on table push_tokens is 'data-source: shop-owned';
