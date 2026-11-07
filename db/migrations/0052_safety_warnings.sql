-- CPSC's product safety warnings: what it publishes when a company can't be found or won't cooperate. There is no recall and
-- no remedy. Apart from recalls on purpose, so a warning can't reach a recall count, Replay, the eval or a refund.
create table safety_warnings (
  warning_number   text primary key,
  warned_on        date not null,
  title            text not null,
  product          text not null,
  description      text not null,
  hazard           text not null,
  consumer_action  text not null,
  sold_at          text not null,
  raw_sha256       text not null,
  first_seen_at    timestamptz not null default now()
);
comment on table safety_warnings is 'data-source: cpsc-public';

create table safety_warning_reads (
  only_row  boolean primary key default true check (only_row),
  ok_at     timestamptz not null
);
comment on table safety_warning_reads is 'data-source: own';

-- A shop's own title that came near a warning. Deleted with the shop.
create table safety_warning_matches (
  shop_id         uuid not null references shops (id) on delete cascade,
  warning_number  text not null references safety_warnings (warning_number) on delete cascade,
  item_title      text not null,
  primary key (shop_id, warning_number, item_title)
);
comment on table safety_warning_matches is 'data-source: shop-owned';
