-- A live catch's seconds were worked out from PayPal's capture time, so they go by PayPal's 48-hour rule.
comment on table live_catch_runs is 'data-source: paypal';
