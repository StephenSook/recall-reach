-- Which version of the recall a family's answer was given on. CPSC can widen a recall later, and a no doesn't carry over.
alter table notices add column check_recall_sha text;
