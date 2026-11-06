-- What the two texts share, strongest first. See server/match/verdict.ts. Rows from before this column
-- have none, and are treated as having the brand behind them, so nothing already shown gets weaker.
alter table recall_matches add column strength text check (strength in ('CONFIRMED', 'BRAND', 'PRODUCT_WORDS', 'NO_SHARED_WORDS'));
