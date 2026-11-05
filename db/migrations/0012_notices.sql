-- One message per match, approved by a person. Its state is read from these timestamps: Prepared,
-- Opened in mail, You marked sent, Family responded. "stopped" is the family's own report, not
-- verified disposal. The family's typed answer is not stored, only what it came to.
create table notices (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references shops (id) on delete cascade,
  match_id      uuid not null unique references recall_matches (id) on delete cascade,
  kind          text not null check (kind in ('SAFETY_NOTICE', 'CHECK_REQUEST')),
  prepared_at   timestamptz not null default now(),
  opened_at     timestamptz,
  sent_at       timestamptz,
  responded_at  timestamptz,
  family_stopped boolean not null default false,
  check_result  text check (check_result in ('MATCHES', 'DOESNT_MATCH', 'CANT_TELL'))
);
create index notices_shop_idx on notices (shop_id);
comment on table notices is 'data-source: own';
