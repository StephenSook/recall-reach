-- Claude's claim that every recalled unit has the trait is what would let a "no" count. A person confirms that
-- separately from accepting the question's words, so it can't slip through as part of them.
alter table recall_questions add column scope_confirmed boolean not null default false;
