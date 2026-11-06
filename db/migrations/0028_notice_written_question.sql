-- The question Claude wrote, as it stood when the seller approved the message, so the mail and the family's page
-- ask the same thing whatever happens later. Null when there was none, or the message is not a question.
alter table notices add column written_question jsonb;
