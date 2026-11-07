-- A dispute found while asking PayPal again. The owner must not be told to refund it by hand: PayPal may already have paid the buyer.
alter table refunds add column dispute_seen_at timestamptz;
