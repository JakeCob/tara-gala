-- TG-52 PR 3: the trip's shared checklist ticks and picks. See schema.sql for the commented definition. Private by link:
-- RLS on with no policy; the API reads and writes through DATABASE_URL. Safe to re-run, and a no-op on a database
-- built from schema.sql.

-- The trip's shared checklist and picks (TG-52 PR 3): a tick on a day row of the itinerary's guide ("row:d2-05"), a
-- tick on a to-do ("todo:03"), or a pick ("pick:sunrise" = "B"). Unticking deletes the row. Keys come from the guide.
create table if not exists session_marks (
  session_id    uuid not null references trip_sessions(id) on delete cascade,
  key           text not null check (key ~ '^(row:d[1-9]-[0-9]{2}|todo:[0-9]{2}|pick:[a-z]{1,20})$'),
  value         text not null check (value ~ '^(done|[A-Z])$'),
  updated_at    timestamptz not null default now(),
  primary key (session_id, key)
);

alter table session_marks enable row level security;
