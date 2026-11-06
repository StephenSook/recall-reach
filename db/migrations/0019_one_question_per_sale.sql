-- One question to a family about one sale, however many recalls it could belong to. A confirmed recall
-- is a separate hazard, so safety notices are not limited this way.
alter table notices add column order_line_id uuid references order_lines (id) on delete cascade;
update notices n set order_line_id = m.order_line_id from recall_matches m where m.id = n.match_id;
alter table notices alter column order_line_id set not null;
create unique index notices_one_question_per_sale on notices (order_line_id) where kind = 'CHECK_REQUEST';
