-- When a person read the question. Set with their accept or reject, never by a model.
alter table recall_questions add column reviewed_at timestamptz;
