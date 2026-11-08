-- The public key is random and distinct from the shop id. The URL also needs its HMAC.
alter table shops add column safety_receipt_key uuid not null default gen_random_uuid() unique;

create table safety_receipts (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops (id) on delete cascade,
  item text not null check (length(trim(item)) between 1 and 240),
  brand text check (length(brand) <= 120),
  model text check (length(model) <= 120),
  email_enc text not null,
  created_at timestamptz not null default now(),
  delete_token_hash text not null unique,
  unique (shop_id, id)
);
comment on table safety_receipts is 'data-source: family-given';
create index safety_receipts_created_idx on safety_receipts (created_at);

-- Reuse the matcher, queue and notices without inventing a sale or payment.
alter table recall_matches add column safety_receipt_id uuid;
alter table recall_matches add constraint recall_matches_receipt_shop_fk
  foreign key (shop_id, safety_receipt_id) references safety_receipts (shop_id, id) on delete cascade;
alter table recall_matches drop constraint recall_matches_check;
alter table recall_matches add constraint recall_matches_one_record
  check (num_nonnulls(order_line_id, shop_item_id, safety_receipt_id) = 1);
alter table recall_matches add constraint recall_matches_receipt_no_payment
  check (safety_receipt_id is null or (sale_path is null and join_state is null and paypal_payment_id is null));
drop index recall_matches_one_per_record_idx;
create unique index recall_matches_one_per_record_idx
  on recall_matches (shop_id, recall_id, coalesce(order_line_id, shop_item_id, safety_receipt_id));

alter table notices add column safety_receipt_id uuid references safety_receipts (id) on delete cascade;
alter table notices alter column order_line_id drop not null;
alter table notices add constraint notices_one_record check (num_nonnulls(order_line_id, safety_receipt_id) = 1);
create unique index notices_one_question_per_receipt_idx
  on notices (safety_receipt_id) where kind = 'CHECK_REQUEST';
