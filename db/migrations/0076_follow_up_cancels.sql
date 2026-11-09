-- A save the owner dismissed before it got an answer. If that save lands late, it's refused, so a dismissed reminder can't come back.
-- An attempt id is a random one the page makes for each save. Nothing here comes from PayPal.
create table follow_up_cancels (
  attempt     uuid primary key,
  shop_id     uuid not null references shops (id) on delete cascade,
  created_at  timestamptz not null default now()
);
comment on table follow_up_cancels is 'data-source: shop-owned';
