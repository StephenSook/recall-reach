-- The one question Claude wrote for a recall, from CPSC's text alone. It belongs to the recall, not to any
-- shop, so one shop's words can't reach another's family, and the whole set can be reviewed by a person.
-- A new CPSC snapshot gets a new question.
create table recall_questions (
  recall_sha256        text not null,
  agent_version        text not null,
  recall_id            integer not null references recalls (recall_id),
  outcome              text not null check (outcome in ('QUESTION', 'ABSTAINED', 'NO_QUESTION', 'REFUSED')),
  question             text,
  evidence             text, -- exact words from the CPSC record that the question rests on
  every_recalled_unit  boolean not null default false,
  abstain_reason       text,
  review               text check (review in ('ACCEPTED', 'REJECTED')), -- a person's accept is the only thing that lets a no count; a rejection may be made on the owner's instruction
  model                text not null,
  input_tokens         integer not null,
  output_tokens        integer not null,
  cost_micros          bigint not null,
  created_at           timestamptz not null default now(),
  primary key (recall_sha256, agent_version),
  check ((outcome = 'QUESTION') = (question is not null)),
  check ((question is null) = (evidence is null))
);
comment on table recall_questions is 'data-source: cpsc-public';
