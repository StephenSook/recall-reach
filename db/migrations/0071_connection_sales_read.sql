-- Whether the latest read of a connected shop's sales covered every window it asked for. A read that stopped partway
-- can't show that only one payment matches a sale, so refunds from the shop's own account wait for one that didn't.
alter table shop_paypal_connections add column sales_read_complete boolean not null default false;
alter table shop_paypal_connections add column sales_read_at timestamptz;
