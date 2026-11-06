-- PayPal refused a repeat. From then on a person checks PayPal, and no further repeat goes out. A column of
-- its own, never cleared, so a later answer that replaces the failure text cannot reopen it.
alter table refunds add column repeat_refused_at timestamptz;
