-- PayPal webhook deliveries that passed signature verification. Unverified deliveries are
-- never stored. PayPal's resource id (a capture or refund id) is kept only as a SHA-256
-- hash: this table records that an event arrived, not PayPal transaction data.
create table paypal_webhook_events (
  event_id             text primary key,  -- PayPal's event id; a redelivery is a duplicate
  event_type           text not null,
  resource_type        text,
  resource_id_sha256   text,
  event_create_time    timestamptz,
  verification_method  text not null check (verification_method in ('self')),
  received_at          timestamptz not null default now()
);

create index paypal_webhook_events_received_at_idx on paypal_webhook_events (received_at desc);
