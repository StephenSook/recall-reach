-- A shop's link to its own PayPal account, made through Partner Referrals. An account link, not transaction data, so it's
-- kept like the shop: it goes with the shop (a demo shop within 48 hours, a real one after 7 days) and on disconnect. The
-- seller's merchant id is encrypted with the shop's own key; its HMAC finds the row when PayPal says consent was revoked.
create table shop_paypal_connections (
  shop_id                  uuid primary key references shops (id) on delete cascade,
  tracking_id              text not null unique, -- an HMAC of the shop id, the only thing PayPal is told about the shop
  started_at               timestamptz not null,
  merchant_id_sealed       text,
  merchant_id_hmac         text,
  payments_receivable      boolean,
  primary_email_confirmed  boolean,
  scopes                   text[] not null default '{}',
  status_read_at           timestamptz,
  refusal                  text -- PayPal's own answer when it refused, with its debug id
);
create index shop_paypal_connections_merchant_idx on shop_paypal_connections (merchant_id_hmac);
comment on table shop_paypal_connections is 'data-source: shop-owned';
