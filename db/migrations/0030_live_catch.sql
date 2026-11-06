-- A sale caught as it happens. The line is written from the shop's own listing first, then PayPal's webhook
-- runs the check for it. Only these lines are caught, so a seeded order's webhook does nothing.
alter table order_lines add column live_sale boolean not null default false;

-- When this app put the match in the queue. Our own clock, never PayPal's: the elapsed time on the card is
-- worked out from the payment row while it exists, and goes when the purge removes that row.
alter table recall_matches add column caught_at timestamptz;

-- The measurement: how many seconds, and nothing about whose sale.
create table live_catch_runs (
  id         bigint generated always as identity primary key,
  seconds    numeric(10, 1) not null,
  caught_at  timestamptz not null default now()
);
comment on table live_catch_runs is 'data-source: own';
