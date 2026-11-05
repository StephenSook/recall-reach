-- Which payment a match identified, and which one an approval was given for. These hold our own row
-- id, never a PayPal id, and go empty when the 46-hour purge removes the payment.
alter table recall_matches add column paypal_payment_id uuid references paypal_payments (id) on delete set null;
alter table approvals add column paypal_payment_id uuid references paypal_payments (id) on delete set null;
