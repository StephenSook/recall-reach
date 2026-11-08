-- PayPal's own answer about each delivery our certificate check verified, asked after we answer PayPal. Our check stays
-- the only gate: a FAILURE or no answer never turns a delivery away. Null means not asked yet.
alter table paypal_webhook_events add column paypal_check text check (paypal_check in ('SUCCESS', 'FAILURE', 'UNAVAILABLE'));
alter table paypal_webhook_events add column paypal_checked_at timestamptz;
-- A refund event's own status and amount, so the refund page can set them beside the refund PayPal reads back. Nothing
-- else from the event is kept, and the row goes with the rest at the 48-hour cutoff.
alter table paypal_webhook_events add column resource_status text;
alter table paypal_webhook_events add column resource_amount_cents integer;
alter table paypal_webhook_events add column resource_currency text;
