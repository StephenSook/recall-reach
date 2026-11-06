-- What the two texts share, strongest first. See server/match/verdict.ts. Rows from before this column
-- have none. A gap with none counts as weak: unknown evidence is not enough to contact a family.
alter table recall_matches add column strength text check (strength in ('CONFIRMED', 'BRAND', 'PRODUCT_WORDS', 'NO_SHARED_WORDS'));
