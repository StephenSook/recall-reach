-- The seller was sent to look in PayPal itself. The line stays blocked: this app cannot tell whether a
-- refund landed, and a new request id could refund the same sale twice.
alter table refunds add column seller_sent_to_paypal_at timestamptz;
