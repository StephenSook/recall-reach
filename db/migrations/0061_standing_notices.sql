-- A shop's choice, for one recall, to have notices prepared without approving each one. Nothing sends by itself: each still
-- opens in the shop's own mail. Deleting the row turns it off.
create table standing_notices (
  shop_id     uuid not null references shops (id) on delete cascade,
  recall_id   integer not null,
  turned_on_at timestamptz not null default now(),
  primary key (shop_id, recall_id)
);
comment on table standing_notices is 'data-source: own';

-- When the owner asked for a second notice. It changes the subject of what opens in their mail, and sends nothing.
alter table notices add column second_prepared_at timestamptz;
