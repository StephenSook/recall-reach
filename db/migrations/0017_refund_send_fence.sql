-- Names the send that holds the lease. A send that outlives its lease may not settle the row, so only
-- the current holder's answer counts.
alter table refunds add column send_lease_id uuid;
