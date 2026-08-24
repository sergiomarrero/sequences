-- Shared facts: the handful of round-level truths every sequence keeps
-- asking for (where the round stands, latest traction, studio shape).
-- Steps reference them as {{key}} tokens; they are filled once here and
-- resolved at send time, instead of hand-filled per sequence.

create table if not exists crm_sequence_facts (
  key text primary key,
  label text not null,
  value text not null default '',
  updated_at timestamptz not null default now()
);

insert into crm_sequence_facts (key, label) values
  ('round_status', 'Where the round stands and when it closes'),
  ('recent_win',   'One concrete thing that moved recently'),
  ('studio_shape', 'How many ventures, over what period')
on conflict (key) do nothing;
