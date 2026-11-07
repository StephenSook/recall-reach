-- When the main model last answered the daily call. last_ok_at is the cheapest model's, which can stay fresh while the main one is failing.
alter table claude_pings add column last_main_ok_at timestamptz;
