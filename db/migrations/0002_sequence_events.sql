-- Activity log for sequences: one row per thing that happened to a
-- sequence, whoever did it. Written best-effort by the app and by
-- Claude's daily run, read back on the Sequences page so a
-- misbehaving sequence can be diagnosed from what actually occurred
-- rather than from memory.
--
-- Same access model as every other crm_ table: RLS on, no policies,
-- service role only.

create table crm_sequence_events (
  id            uuid primary key default gen_random_uuid(),
  sequence_id   uuid not null references crm_sequences(id) on delete cascade,
  at            timestamptz not null default now(),
  -- who acted: 'user' (the web UI), 'sync' (Claude's mailman run),
  -- or 'system' (a rule the server applied on its own)
  actor         text not null default 'user',
  -- short verb, e.g. created, approved, stopped, edited, sent, held
  action        text not null,
  -- human-readable specifics; safe to show verbatim in the UI
  detail        text,
  -- which email in the sequence this concerned, when relevant
  step_position int
);

create index crm_sequence_events_seq_idx
  on crm_sequence_events (sequence_id, at desc);

alter table crm_sequence_events enable row level security;
