-- CPSC recalls, as published by the Consumer Product Safety Commission Recalls API.
-- Public data. `raw` keeps the full record so notices can quote it verbatim;
-- `raw_sha256` identifies the exact snapshot any later decision was based on.
create table recalls (
  recall_id          integer primary key,
  recall_number      text not null,
  recall_date        date not null,
  -- CPSC sends this with no time zone (measured: always midnight), so it is stored as sent.
  last_publish_date  timestamp not null,
  title              text not null,
  description        text not null,
  url                text not null,
  products           jsonb not null,
  hazards            jsonb not null,
  remedies           jsonb not null,
  remedy_options     jsonb not null,
  retailers          jsonb not null,
  images             jsonb not null,
  raw                jsonb not null,
  raw_sha256         text not null,
  -- When this app first saw the recall. CPSC's own publish time has no time of day,
  -- so publish-to-queue timing is measured from here.
  first_seen_at      timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index recalls_recall_date_idx on recalls (recall_date desc);
create index recalls_last_publish_date_idx on recalls (last_publish_date desc);
create index recalls_recall_number_idx on recalls (recall_number);

-- One row per pull from the CPSC API, so every load is auditable.
create table cpsc_pulls (
  id           bigint generated always as identity primary key,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  range_field  text not null check (range_field in ('RecallDate', 'LastPublishDate')),
  range_start  date not null,
  range_end    date not null,
  status       text not null check (status in ('running', 'ok', 'partial', 'failed')),
  fetched      integer,
  inserted     integer,
  updated      integer,
  unchanged    integer,
  invalid      integer,
  invalid_detail jsonb,
  error        text
);

create index cpsc_pulls_started_at_idx on cpsc_pulls (started_at desc);
