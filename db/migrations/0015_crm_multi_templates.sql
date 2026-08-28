-- Multiple named templates. Until now there was exactly one implicit
-- template: the rows of crm_sequence_templates, unique by position. This
-- migration names that template ("Cold intro"), makes room for more, and
-- seeds a second one ("Pickup follow-up") with the arc the enrollment
-- scan drafts from, so both live in the tool and are editable there.

create table crm_templates (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  description text not null default '',
  is_default  boolean not null default false,
  created_at  timestamptz not null default now()
);
alter table crm_templates enable row level security;

insert into crm_templates (name, description, is_default) values
  ('Cold intro',
   'The 8-email house arc: the introduction starts a fresh thread on approval, and seven follow-ups ride that thread. Built from reply-rate research: every follow-up adds something new; why-you personalization comes early, where it lifts replies most; every email has one ask and invites a one-word answer; spacing widens through the sequence (2, 3, 3, 4, 4, 5, 6 business days).',
   true),
  ('Pickup follow-up',
   'For a first email you already sent yourself from Gmail: seven follow-ups that pick up on that thread. The enrollment scan (LP/Enroll label) drafts from this, stamping your original email as step 1. Created by hand instead, fill the brackets before approving; the gate holds until you do.',
   false);

-- Existing template rows become the Cold intro template.
alter table crm_sequence_templates
  add column template_id uuid references crm_templates(id) on delete cascade;
update crm_sequence_templates
  set template_id = (select id from crm_templates where name = 'Cold intro');
alter table crm_sequence_templates alter column template_id set not null;
alter table crm_sequence_templates drop constraint crm_sequence_templates_position_key;
alter table crm_sequence_templates
  add constraint crm_sequence_templates_template_position_key
  unique (template_id, position);

-- Which template a sequence was drafted from. The star (promote) writes
-- back to this template. Null means it predates this migration and is
-- treated as the default template.
alter table crm_sequences
  add column template_id uuid references crm_templates(id) on delete set null;

-- The pickup arc. Positions 1-7 here are the seven follow-ups; when the
-- enrollment scan drafts a sequence it stamps Sergio's original email as
-- step 1 and these become steps 2-8. No subjects: they are replies on his
-- thread and keep Re:. Follow-up 1 waits 1 business day because his
-- original email is already at least a day old when the scan drafts.
insert into crm_sequence_templates (template_id, position, title, subject, body, wait_days)
select t.id, v.position, v.title, v.subject, v.body, v.wait_days
from crm_templates t,
(values
  (1, 'First follow-up: the short version', null,
$tpl$Hi [First name],

Following up on my note below with the short version: I am building Rebel One Venture Studios, AI-native studios that build profitable companies in economic mobility infrastructure, and we are raising $25M for Studio 01: {{studio_shape}}.

A one-line reply either way is genuinely helpful.

Best,
Sergio$tpl$, 1),
  (2, 'Why you, specifically', null,
$tpl$Hi [First name],

One reason I wrote to you rather than a list: [why them]. If I have read that right, this is worth 25 minutes of your time.

Worth a look?

Best,
Sergio$tpl$, 3),
  (3, 'Something concrete: deck and calendar', null,
$tpl$Hi [First name],

In case something concrete is easier to react to, here is the deck: https://deck.rbl1.com/

If a conversation is faster than reading, grab 25 minutes here: https://booksergio.rbl1.com/30min

Best,
Sergio$tpl$, 4),
  (4, 'A real update', null,
$tpl$Hi [First name],

Quick update so you are reacting to the current picture, not the one from my first note: {{recent_win}}

Happy to send materials if that is easier than a call.

Best,
Sergio$tpl$, 4),
  (5, 'The direct question', null,
$tpl$Hi [First name],

I would rather not clutter your inbox, so let me make this easy to answer: is this something you would want to take a closer look at in the next couple of weeks?

A one-word answer is a full answer.

Best,
Sergio$tpl$, 5),
  (6, 'Where the round stands', null,
$tpl$Hi [First name],

A note on where things stand: {{round_status}}

I wanted you to have a real chance to weigh in before then, since I would like you in this.

Best,
Sergio$tpl$, 5),
  (7, 'The close', null,
$tpl$Hi [First name],

I will close the loop on my end; this is my last note on this. If the issue was timing rather than fit, say the word and I will circle back when there are companies to react to.

Either way, thanks for reading, and if I can ever be useful to you or your portfolio, ask.

Best,
Sergio$tpl$, 6)
) as v(position, title, subject, body, wait_days)
where t.name = 'Pickup follow-up';
