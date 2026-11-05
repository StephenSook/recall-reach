-- Whether this run read PayPal at all. A run that did not has no business saying "no PayPal record".
alter table shop_runs add column paypal_searched boolean not null default false;
