-- A checkout reservation is not a sale until a verified completed capture confirms it.
-- Keep the row for delayed webhooks, but exclude it from shop checks and recall sweeps.
alter table order_lines add column capture_pending boolean not null default false;

-- Older live rows may already be abandoned reservations. A caught card remains confirmation
-- after the PayPal payment is purged; otherwise require a payment that was actually captured.
-- A confirmed sale with no caught card and a purged payment cannot be distinguished from an abandoned reservation.
update order_lines l set capture_pending = true
where l.live_sale
  and not exists (
    select 1 from paypal_payments p where p.shop_id = l.shop_id and p.order_number = l.order_number
      and p.capture_status in ('COMPLETED', 'REFUNDED', 'PARTIALLY_REFUNDED')
  )
  and not exists (select 1 from recall_matches m where m.order_line_id = l.id and m.caught_at is not null);
