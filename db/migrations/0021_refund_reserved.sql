-- "reserved" means nothing has left for PayPal, so money certainly has not moved. The row moves to
-- "unconfirmed" just before the request goes out, because from that moment the outcome is unknown.
alter table refunds drop constraint refunds_status_check;
alter table refunds add constraint refunds_status_check check (status in ('reserved', 'pending', 'refunded', 'failed', 'unconfirmed'));
