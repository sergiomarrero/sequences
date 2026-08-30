-- Earliest send day per sequence. Null = auto: the first send goes out on
-- the next run after approval, exactly the pre-existing behavior. Set, the
-- scheduled run sends nothing for the sequence before that day; explicit
-- send_now and direct chat asks stay exempt.
alter table crm_sequences add column start_date date;
