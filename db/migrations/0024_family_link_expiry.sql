-- A family link stops taking answers after this. The page itself keeps showing what CPSC says.
alter table notices add column family_link_expires_at timestamptz not null default now() + interval '180 days';
