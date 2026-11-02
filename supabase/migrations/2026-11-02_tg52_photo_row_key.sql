-- TG-52 PR 4: a trip photo's checklist row (owner-approved 2026-11-01): the row of the itinerary's guide the group was
-- at when it was taken, e.g. 'd2-05'. Safe to re-run, and a no-op on a database built from schema.sql.
alter table session_files add column if not exists row_key text check (row_key ~ '^d[1-9]-[0-9]{2}$');
