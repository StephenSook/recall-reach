-- How soon a recall's hazard warrants a follow-up, as Claude read it from CPSC's public text. It belongs to the recall, not to
-- any shop, and it knows nothing about a sale. A new CPSC snapshot gets new advice.
create table follow_up_advice (
  recall_sha256  text not null,
  agent_version  text not null,
  recall_id      integer not null references recalls (recall_id),
  within_days    integer not null check (within_days between 1 and 30),
  reason         text not null,
  hazard_quote   text not null, -- exact words from CPSC's hazard text
  model          text not null,
  input_tokens   integer not null,
  output_tokens  integer not null,
  cost_micros    bigint not null,
  created_at     timestamptz not null default now(),
  primary key (recall_sha256, agent_version)
);
comment on table follow_up_advice is 'data-source: cpsc-public';

-- A reminder the owner confirmed on one sale's row. It's a date on their own timeline and queue card, and it sends nothing.
create table follow_ups (
  match_id       uuid primary key references recall_matches (id) on delete cascade,
  shop_id        uuid not null references shops (id) on delete cascade,
  due_on         date not null,
  reason         text not null,
  hazard_quote   text not null,
  moved_earlier  boolean not null default false,
  recall_sha256  text not null, -- the CPSC text the reason and quote came from; a new snapshot retires this
  confirmed_at   timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index follow_ups_shop on follow_ups (shop_id);
comment on table follow_ups is 'data-source: shop-owned';
