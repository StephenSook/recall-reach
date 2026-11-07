-- The family's own report that they gave the product to someone else. It moves no state and joins no count.
alter table notices add column family_passed_on boolean not null default false;
