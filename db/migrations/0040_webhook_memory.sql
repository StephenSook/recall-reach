-- This table is what remembers a delivery once the purge has taken its event row, so it is looked up by event too.
-- It holds the bytes as well: PayPal's signature covers only a CRC32 of the body, so a captured transmission sent again
-- with crafted bytes of the same CRC verifies. Null on rows from before this column, which can't be compared.
alter table paypal_webhook_transmissions add column body_hmac text;
create index paypal_webhook_transmissions_event on paypal_webhook_transmissions (event_id_hmac);
