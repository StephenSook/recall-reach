-- One offer the shopping agent made, good for one sandbox order, for a few minutes. Public listing words and a price, and
-- nothing from PayPal or about a buyer. finished_at means PayPal's order read back as completed.
create table shopping_slips (
  id           uuid primary key default gen_random_uuid(),
  listing_id   text not null,
  title        text not null,
  brand        text,
  price_cents  integer not null check (price_cents > 0),
  currency     text not null,
  cart_hash    text not null,
  expires_at   timestamptz not null,
  used_at      timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz not null default now()
);
comment on table shopping_slips is 'data-source: own';
