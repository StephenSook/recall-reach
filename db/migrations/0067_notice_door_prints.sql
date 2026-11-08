-- The owner's print actions, not proof that paper left a printer. No buyer or payment data.
-- These records go with the notice and shop under the existing deletion rules.
create table notice_door_prints (
  notice_id   uuid not null references notices (id) on delete cascade,
  shop_id     uuid not null references shops (id) on delete cascade,
  action_id   uuid not null,
  session_id  text not null,
  printed_at  timestamptz not null default now(),
  primary key (notice_id, action_id)
);
create index notice_door_prints_shop_idx on notice_door_prints (shop_id, notice_id, printed_at desc);
comment on table notice_door_prints is 'data-source: own';
