-- The shop's own records. A one-of-a-kind resale listing leaves the catalog once it sells, so
-- order_lines (from the shop's own export) are the record of what was sold; shop_items are what is
-- listed now. Buyer email, if the shop's file has one, is encrypted per shop (server/privacy/contactCipher.ts).
create table shops (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  kind        text not null check (kind in ('DEMO', 'REAL')),
  created_at  timestamptz not null default now()
);
comment on table shops is 'data-source: own';

create table shop_items (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references shops (id) on delete cascade,
  sku          text,
  title        text not null,
  description  text not null default '',
  price_cents  integer check (price_cents >= 0),
  currency     text,
  listed       boolean not null default true,
  source       text not null, -- where this text came from
  imported_at  timestamptz not null default now()
);
create index shop_items_shop_idx on shop_items (shop_id);
comment on table shop_items is 'data-source: shop-owned';

create table order_lines (
  id                 uuid primary key default gen_random_uuid(),
  shop_id            uuid not null references shops (id) on delete cascade,
  order_number       text not null, -- the shop's own number; links to PayPal invoice_id or custom_id
  line_no            integer not null check (line_no > 0),
  title              text not null,
  sku                text,
  quantity           integer not null check (quantity > 0),
  unit_price_cents   integer not null check (unit_price_cents >= 0),
  discount_cents     integer not null default 0 check (discount_cents >= 0),
  currency           text not null,
  ordered_on         date not null, -- as the shop's file states it
  payment_reference  text,
  buyer_email_enc    text,
  source             text not null,
  imported_at        timestamptz not null default now(),
  unique (shop_id, order_number, line_no)
);
create index order_lines_shop_idx on order_lines (shop_id);
comment on table order_lines is 'data-source: shop-owned';
