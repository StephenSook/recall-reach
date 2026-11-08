-- Runs of the shopping agent on one of the page's own example asks, for /evidence/shopper. Only those are kept, so no
-- visitor's words are published: the example's words, public listing words and prices, recall results, and the models
-- that answered. Its payment is kept here too, since the offer row it came from is deleted after 48 hours.
create table shopper_example_runs (
  id                uuid primary key default gen_random_uuid(),
  ran_at            timestamptz not null,
  ask               text not null,
  budget_cents      integer not null,
  outcome           text not null,
  models            text[] not null default '{}',
  steps             jsonb not null default '[]',
  blocked           jsonb not null default '[]',
  pick              jsonb,
  slip_id           uuid references shopping_slips (id) on delete set null,
  offer_expires_at  timestamptz,
  paid_at           timestamptz
);
create index shopper_example_runs_ran_at_idx on shopper_example_runs (ran_at desc);
comment on table shopper_example_runs is 'data-source: own';
