-- What this app asked PayPal, for one shop to read: the call's shape and PayPal's debug id. No payloads, and ids are out of
-- the paths. The debug id came from PayPal, so these rows go with the rest of PayPal's data.
create table paypal_calls (
  id             bigint generated always as identity primary key,
  shop_id        uuid not null references shops (id) on delete cascade,
  received_at    timestamptz not null default now(),
  method         text not null,
  path_template  text not null,
  status         integer not null,
  ms             integer not null,
  debug_id       text
);
create index paypal_calls_shop_idx on paypal_calls (shop_id, id desc);
comment on table paypal_calls is 'data-source: paypal';
