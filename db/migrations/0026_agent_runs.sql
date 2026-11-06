-- What Claude found when it checked one recall against one shop record. It adds evidence beside the
-- matcher's verdict and changes nothing else. Reused while both texts are unchanged. A demo shop's text is
-- the same for every visitor, so its answers are shared (shop_id null); a real shop's stay with that shop.
create table agent_runs (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid references shops (id) on delete cascade,
  recall_sha256  text not null,
  item_sha256    text not null,
  agent_version  text not null,
  outcome        text not null check (outcome in ('FINDING', 'NO_FINDING', 'REFUSED', 'STEP_LIMIT')),
  finding        text check (finding in ('SAME_PRODUCT', 'CANT_TELL', 'DIFFERENT_PRODUCT')),
  evidence       jsonb not null default '[]',
  missing_field  text,
  reason         text,
  trace          jsonb not null,
  model          text not null,
  input_tokens   integer not null,
  output_tokens  integer not null,
  cost_micros    bigint not null,
  created_at     timestamptz not null default now(),
  check ((outcome = 'FINDING') = (finding is not null)),
  unique nulls not distinct (shop_id, recall_sha256, item_sha256, agent_version)
);
comment on table agent_runs is 'data-source: shop-owned';

alter table recall_matches add column agent_run_id uuid references agent_runs (id) on delete set null;

-- The day's spend on Claude, checked before every call.
create table agent_spend (
  day          date primary key,
  cost_micros  bigint not null
);
comment on table agent_spend is 'data-source: own';
