-- A row of this order could not be read. Its discount was shared out over the rows that could, so its
-- refund amounts cannot be trusted until the shop's file is fixed. Matching and notices still run.
alter table order_lines add column order_incomplete boolean not null default false;
