-- At most one refund per order line that is not settled as failed. Two approvals issued before either
-- runs would otherwise each send one, with different request ids, and PayPal would honor both.
create unique index refunds_one_open_per_line on refunds (order_line_id) where status <> 'failed';
