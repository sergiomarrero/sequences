-- Review checkpoint: a per-step gate Sergio toggles in the UI.
--
-- Today the only way to pause a sequence mid-flight is to type [brackets]
-- into the email text, which pollutes the message and has to be remembered
-- and removed. A checkpoint is that same hard stop as a first-class flag:
-- the sequence sends up TO the checkpointed step, then holds and waits for
-- him to read, edit if needed, and untick. Toggling is one click and the
-- text is never touched.
alter table crm_sequence_steps
  add column if not exists review_gate boolean not null default false;

comment on column crm_sequence_steps.review_gate is
  'When true, the run must not send this step: the sequence holds here until the flag is cleared in the UI. Ignored once sent_at is set.';
