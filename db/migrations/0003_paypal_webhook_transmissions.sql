-- Each signed PayPal transmission is accepted for one event only. PayPal's signature covers
-- transmission id, time, webhook id and only a CRC32 of the body, so a captured transmission
-- could be re-sent with a crafted body that has the same CRC. Refusing a transmission id that
-- was already used for a different event blocks that replay.
create table paypal_webhook_transmissions (
  transmission_id  text primary key,
  event_id         text not null,
  received_at      timestamptz not null default now()
);
