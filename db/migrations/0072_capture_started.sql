-- A capture has begun for this reservation. A cancellation that read PayPal before it began must not release the line.
alter table order_lines add column capture_started boolean not null default false;
