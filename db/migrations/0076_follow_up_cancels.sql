-- A save the owner dismissed before it got an answer. If that save lands late, it's refused, so a dismissed reminder can't come back.
-- An attempt id is a random one the page makes for each save. Nothing here comes from PayPal.
create table follow_up_cancels (
  attempt     uuid primary key,
  shop_id     uuid not null references shops (id) on delete cascade,
  created_at  timestamptz not null default now()
);
comment on table follow_up_cancels is 'data-source: shop-owned';

-- Each change to a reminder takes a number from this as the server receives it: unique and in order, so two can't tie.
create sequence follow_up_arrivals;

-- The newest change each sale's reminder has taken. A change that arrived earlier but lands later is refused, so the order
-- the owner acted in holds even when the page has forgotten what to cancel, as after a reload.
create table follow_up_fences (
  match_id  uuid primary key references recall_matches (id) on delete cascade,
  shop_id   uuid not null references shops (id) on delete cascade,
  arrival   bigint not null
);
comment on table follow_up_fences is 'data-source: shop-owned';
