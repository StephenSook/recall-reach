-- Our own marker for the first create attempt, committed before its POST. A failed plan read does not start the clock.
alter table shop_subscriptions add column create_started_at timestamptz;
comment on column shop_subscriptions.create_started_at is 'data-source: own';

-- Older attempts may already have reached PayPal, even without a recorded id. Keep their original retry cutoff.
update shop_subscriptions set create_started_at = requested_at;
