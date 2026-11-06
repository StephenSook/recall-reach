-- A seller's answer to "is this the recalled product?". Kept: which recall, the shop's own title, and the answer.
-- Never a sale, a buyer or anything PayPal returned. It tests the matcher, it changes no card, and it goes with the shop.
create table seller_answers (
  shop_id        uuid not null references shops (id) on delete cascade,
  recall_number  text not null,
  listing_title  text not null,
  answer         text not null check (answer in ('SAME_PRODUCT', 'DIFFERENT_PRODUCT')),
  primary key (shop_id, recall_number, listing_title)
);
comment on table seller_answers is 'data-source: shop-owned';
