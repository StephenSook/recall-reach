-- Store PayPal ids in the webhook tables only as HMACs under the shop's secret (RECORD_HMAC_SECRET),
-- never raw and never as a plain hash. A plain hash of a PayPal id may still count as transaction
-- history under the Developer Agreement's 48-hour rule.
-- The tables have held no rows since they were created, so they are rebuilt; this refuses to run
-- if that ever stops being true, rather than drop anything.
do $$
begin
  if exists (select 1 from paypal_webhook_events) or exists (select 1 from paypal_webhook_transmissions) then
    raise exception '0004: webhook tables are not empty; write a data-preserving migration instead';
  end if;
end
$$;

drop table paypal_webhook_transmissions;
drop table paypal_webhook_events;

create table paypal_webhook_events (
  event_id_hmac        text primary key,  -- HMAC of PayPal's event id; a redelivery is a duplicate
  event_type           text not null,
  resource_type        text,
  resource_id_hmac     text,              -- HMAC of the capture or refund id the event is about
  event_create_time    timestamptz,
  verification_method  text not null check (verification_method in ('self')),
  received_at          timestamptz not null default now()
);

create index paypal_webhook_events_received_at_idx on paypal_webhook_events (received_at desc);

-- Each signed PayPal transmission is accepted for one event only. PayPal's signature covers only a
-- CRC32 of the body, so a captured transmission could be re-sent with a crafted body that has the
-- same CRC. Refusing a transmission already used for a different event blocks that replay.
create table paypal_webhook_transmissions (
  transmission_id_hmac  text primary key,
  event_id_hmac         text not null,
  received_at           timestamptz not null default now()
);
