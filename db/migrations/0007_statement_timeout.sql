-- A role default of 45 s, for any session that honors role defaults. It does NOT bound the app's
-- pooled connections on Neon: `show statement_timeout` still returned 0 there after this ran
-- (measured 2026-11-05). The bound the app relies on is the client's query_timeout in POOL_CONFIG.
alter role current_user set statement_timeout = '45s';
