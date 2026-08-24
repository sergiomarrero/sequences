-- A send claim: the row-level lock that makes a duplicate send impossible.
--
-- Two ways the same email could go out twice, neither of which the wait-day
-- gate catches:
--   1. Two runs overlap. Both read the step as unsent, both send.
--   2. A run dies between the Gmail send and the sent_at stamp. The record
--      still says unsent, so the next run sends it again.
--
-- Claiming is a single conditional UPDATE, so Postgres serialises it: the
-- second caller re-checks the WHERE against the freshly locked row, sees the
-- claim, and matches nothing. A claim older than the staleness window is
-- reclaimable, so a genuinely crashed run does not wedge the step forever.
alter table crm_sequence_steps
  add column if not exists send_claimed_at timestamptz;

comment on column crm_sequence_steps.send_claimed_at is
  'When a run claimed the right to send this step. Set by the claim endpoint, cleared on release, ignored once sent_at is set.';

-- finding the claim on a step is always by step id, which is already the pk,
-- so no extra index is needed
