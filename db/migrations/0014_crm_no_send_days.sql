-- No-send days: dates the scheduled run must not send sequence email.
-- Weekends are always no-send (the run knows that on its own); this table
-- holds the exceptions beyond weekends, seeded with US federal holidays.
-- Sergio edits the list at the bottom of the Sequences page. Explicit
-- sends (Send now, or asking Claude directly) are exempt: the calendar
-- governs the schedule, not him.
create table if not exists crm_no_send_days (
  day   date primary key,
  label text not null default ''
);

comment on table crm_no_send_days is
  'Dates the scheduled sequence run skips. Send-now and direct asks still send. Also excluded from business-day wait math.';

insert into crm_no_send_days (day, label) values
  -- remaining 2026 US federal holidays
  ('2026-09-07', 'Labor Day'),
  ('2026-10-12', 'Columbus Day'),
  ('2026-11-11', 'Veterans Day'),
  ('2026-11-26', 'Thanksgiving Day'),
  ('2026-12-25', 'Christmas Day'),
  -- 2027 US federal holidays (observed dates where the holiday falls on
  -- a weekend)
  ('2027-01-01', 'New Year''s Day'),
  ('2027-01-18', 'Martin Luther King Jr. Day'),
  ('2027-02-15', 'Washington''s Birthday'),
  ('2027-05-31', 'Memorial Day'),
  ('2027-06-18', 'Juneteenth (observed)'),
  ('2027-07-05', 'Independence Day (observed)'),
  ('2027-09-06', 'Labor Day'),
  ('2027-10-11', 'Columbus Day'),
  ('2027-11-11', 'Veterans Day'),
  ('2027-11-25', 'Thanksgiving Day'),
  ('2027-12-24', 'Christmas Day (observed)')
on conflict (day) do nothing;
