-- The dates of the recalls a run really checked, read from the recalls themselves, so a screen can say them.
alter table shop_runs add column recalls_from date, add column recalls_to date;
