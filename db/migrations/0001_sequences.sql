-- Sequence Desk schema. NOTE: these tables live in the shared Supabase
-- project (discovery) and were already created by the crm repo's migration
-- db/migrations/0009_crm_sequences.sql, which Sergio ran on 08/20/2026.
-- This file is a reference copy so the standalone app documents its own
-- schema; do NOT run it again against a database that already has the
-- tables. The crm_ prefix is kept so both apps read the same data.
--
-- The app is the editor and source of truth. Claude's daily run is the
-- mailman: it reads these tables over the app's API, sends from Sergio's
-- Gmail, and writes results back. RLS with no policies, service role only.

create type crm_sequence_status as enum
  ('pending','approved','active','held','replied','done','stopped','saved','archived');

create table crm_sequences (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  email           text not null,
  firm            text,
  background      text,
  status          crm_sequence_status not null default 'pending',
  -- position of the next unsent step (1-based)
  next_step       int not null default 1,
  gmail_thread_id text,
  -- user asked for an immediate send; the mailman sends then clears it
  send_now        boolean not null default false,
  -- why the next step is held (e.g. unresolved [slot] in the body)
  hold_reason     text,
  is_test         boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table crm_sequence_steps (
  id               uuid primary key default gen_random_uuid(),
  sequence_id      uuid not null references crm_sequences(id) on delete cascade,
  position         int not null,
  title            text not null,
  -- only position 1 (the introduction) carries a subject; replies keep Re:
  subject          text,
  -- plain text; [bracketed] slots must be resolved before this step can send
  body             text not null,
  -- business days of silence required before this step sends (ignored on
  -- position 1, which sends on approval)
  wait_days        int not null default 3,
  sent_at          timestamptz,
  gmail_message_id text,
  unique (sequence_id, position)
);

create index crm_sequence_steps_seq_idx
  on crm_sequence_steps (sequence_id, position);

-- The default sequence new drafts are built from. One row per step.
create table crm_sequence_templates (
  id        uuid primary key default gen_random_uuid(),
  position  int not null unique,
  title     text not null,
  subject   text,
  body      text not null,
  wait_days int not null default 3
);

alter table crm_sequences enable row level security;
alter table crm_sequence_steps enable row level security;
alter table crm_sequence_templates enable row level security;

create or replace function crm_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger crm_sequences_touch
  before update on crm_sequences
  for each row execute function crm_touch_updated_at();
