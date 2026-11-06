-- A phone is on one shop at a time, so the token alone is the key. Moving one is then a single atomic statement.
alter table push_tokens drop constraint push_tokens_pkey;
alter table push_tokens add primary key (token);
create index push_tokens_shop_idx on push_tokens (shop_id);
