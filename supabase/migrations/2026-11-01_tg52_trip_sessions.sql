-- TG-52: trip sessions. See schema.sql for the commented definitions; this file adds them to a database built before
-- TG-52. Private by link: RLS on with no policy, so anon and authenticated see nothing; the API reads and writes
-- through DATABASE_URL. Safe to re-run, and a no-op on a database built from the current schema.sql.
create table if not exists trip_sessions (
  id            uuid primary key default gen_random_uuid(),
  share_slug    text unique not null default encode(gen_random_bytes(16), 'hex'),  -- 128 bits: the link is the key
  name          text not null check (char_length(name) between 1 and 40),
  start_date    date not null,
  return_date   date not null,
  itinerary_id  uuid references itineraries(id) on delete set null,
  wallet_id     uuid references wallets(id) on delete set null,
  created_at    timestamptz not null default now(),
  check (return_date between start_date and start_date + 30)
);

-- The trip's place to stay: one per session, typed in by the party (never from our data). Times are Manila wall time.
create table if not exists session_hotels (
  session_id    uuid primary key references trip_sessions(id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 80),
  address       text not null default '' check (char_length(address) <= 200),
  check_in      timestamp,
  check_out     timestamp,
  booking_ref   text not null default '' check (char_length(booking_ref) <= 40),
  notes         text not null default '' check (char_length(notes) <= 300),
  updated_at    timestamptz not null default now(),
  check (check_out is null or check_in is null or check_out > check_in)
);

alter table trip_sessions  enable row level security;
alter table session_hotels enable row level security;
