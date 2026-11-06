-- When the accept or reject was recorded. Only a person's accept lets a no count; a rejection may be made on the owner's instruction.
alter table recall_questions add column reviewed_at timestamptz;
