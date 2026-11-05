-- While a send to PayPal may still be running. PayPal "might fail" a second simultaneous request with
-- the same id (idempotency page, read 2026-11-05), and that failure must never read as a clear refusal,
-- so only one send runs at a time. A lease and not a lock, so a crash mid-send cannot block recovery.
alter table refunds add column send_lease_until timestamptz;
