-- TG-61 Edit the itinerary (owner-approved 2026-11-05): a trip's edited copy keeps every version, and a trip's own
-- places from a pasted Google Maps link. Two new tables, no change to an existing one. Safe to re-run, and a no-op on a
-- database built from schema.sql. Run it with psql -1, so it's all or nothing.
create table if not exists itinerary_versions (
  id            uuid primary key default gen_random_uuid(),
  itinerary_id  uuid not null references itineraries(id) on delete cascade,
  session_id    uuid not null references trip_sessions(id) on delete cascade,  -- the trip that owns the copy
  based_on      uuid references itineraries(id) on delete set null,            -- version 0: the shared plan it was copied from
  seq           integer not null check (seq between 0 and 9999),
  source        text not null check (source in ('copy', 'hand', 'chat', 'undo')),
  plan          jsonb not null,                                                  -- the whole plan after this change
  changes       jsonb not null check (jsonb_typeof(changes) = 'array' and jsonb_array_length(changes) between 1 and 4),
                -- the change lines, written by the server: [{"word", "day", "text"}]
  created_at    timestamptz not null default now(),
  unique (itinerary_id, seq),
  check (based_on is null or seq = 0)
);
create index if not exists itinerary_versions_session on itinerary_versions (session_id);
alter table itinerary_versions enable row level security;  -- no policy: API only, like the trip's other tables

create table if not exists trip_places (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references trip_sessions(id) on delete cascade,  -- deleted with the trip
  name        text not null check (char_length(name) between 1 and 80),
  lat         double precision not null check (lat between -90 and 90),
  lng         double precision not null check (lng between -180 and 180),
  maps_url    text not null check (maps_url ~ '^https://' and char_length(maps_url) <= 500),
  created_at  timestamptz not null default now()
);
create index if not exists trip_places_session on trip_places (session_id);
alter table trip_places enable row level security;  -- no policy
