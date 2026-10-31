-- Tara Gala MVP schema (Supabase / PostgreSQL)
-- Scope: Manila to Baguio, door to door. Run once in the Supabase SQL editor.
-- Design rules:
--   * Every trip and last-mile route records where it came from and when it was last verified.
--   * The AI planner may only reference rows that exist here (trip_id, spot_id, last_mile_route_id).
--   * Fares are stored in PHP as numeric(8,2).

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type service_class as enum (
  'regular_aircon', 'deluxe', 'super_deluxe', 'executive', 'premiere',
  'first_class', 'luxury', 'royal_class', 'p2p'
);

create type data_source as enum ('manual', 'scraped', 'crowd');

create type trip_report_status as enum ('ran', 'cancelled', 'time_changed', 'sold_out');

create type last_mile_mode as enum ('jeep', 'taxi', 'walk', 'tricycle', 'van', 'grab');

create type spot_category as enum (
  'park', 'food', 'market', 'museum', 'viewpoint', 'shopping', 'church', 'cafe', 'other'
);

create type passenger_type as enum ('adult', 'student', 'senior', 'pwd', 'child');

-- ---------------------------------------------------------------------------
-- Operators and terminals
-- ---------------------------------------------------------------------------
create table operators (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null,            -- 'victory-liner'
  name          text not null,
  website_url   text,
  facebook_url  text,
  booking_url   text,                             -- where users actually buy tickets
  booking_notes text,                             -- e.g. 'online booking has no student discount'
  created_at    timestamptz not null default now()
);

create table terminals (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,               -- 'vl-cubao'
  name        text not null,                      -- 'Victory Liner Cubao'
  city        text not null,                      -- 'Quezon City', 'Baguio'
  address     text,
  lat         double precision,
  lng         double precision,
  notes       text,                               -- gates, landmarks, where to queue
  created_at  timestamptz not null default now()
);

create table operator_terminals (
  operator_id uuid not null references operators(id) on delete cascade,
  terminal_id uuid not null references terminals(id) on delete cascade,
  primary key (operator_id, terminal_id)
);

-- ---------------------------------------------------------------------------
-- Routes: one origin, destination, route variant and class
-- e.g. Victory Liner Cubao -> Baguio, via Luisita, regular aircon
-- ---------------------------------------------------------------------------
create table routes (
  id                      uuid primary key default gen_random_uuid(),
  operator_id             uuid not null references operators(id) on delete cascade,
  origin_terminal_id      uuid not null references terminals(id),
  destination_terminal_id uuid not null references terminals(id),
  via                     text,                   -- 'Gerona', 'Urdaneta', 'Luisita', 'TPLEX'
  class                   service_class not null,
  fare_php                numeric(8,2),
  travel_minutes          int,                    -- typical, not guaranteed
  seat_layout             text,                   -- '2x2', '2x1'
  has_restroom            boolean,
  booking_url             text,                   -- overrides operator booking_url when set
  notes                   text,
  created_at              timestamptz not null default now(),
  constraint routes_distinct_ends check (origin_terminal_id <> destination_terminal_id)
);

create index routes_origin_dest_idx on routes (origin_terminal_id, destination_terminal_id);

-- ---------------------------------------------------------------------------
-- Trips: each scheduled departure on a route
-- ---------------------------------------------------------------------------
create table trips (
  id                uuid primary key default gen_random_uuid(),
  route_id          uuid not null references routes(id) on delete cascade,
  departure_time    time not null,                -- local Manila time
  days_of_week      smallint[] not null default '{0,1,2,3,4,5,6}', -- 0 = Sunday
  valid_from        date,
  valid_to          date,
  is_active         boolean not null default true,
  source            data_source not null default 'manual',
  source_url        text,                         -- operator page or FB post it came from
  last_verified_at  timestamptz,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint trips_valid_range check (valid_to is null or valid_from is null or valid_to >= valid_from),
  constraint trips_days_valid check (days_of_week <@ '{0,1,2,3,4,5,6}'::smallint[]),
  unique (route_id, departure_time, valid_from)
);

create index trips_route_time_idx on trips (route_id, departure_time) where is_active;

-- Your own checks now; crowd reports after the trip
create table trip_reports (
  id           uuid primary key default gen_random_uuid(),
  trip_id      uuid not null references trips(id) on delete cascade,
  travel_date  date not null,
  status       trip_report_status not null,
  actual_time  time,                              -- when status = 'time_changed'
  note         text,
  reported_by  uuid,                              -- auth.users id later; null = admin
  created_at   timestamptz not null default now()
);

create index trip_reports_trip_idx on trip_reports (trip_id, travel_date desc);

-- ---------------------------------------------------------------------------
-- Baguio spots and last-mile routes
-- ---------------------------------------------------------------------------
create table spots (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null,           -- 'burnham-park'
  name            text not null,
  city            text not null default 'Baguio',
  category        spot_category not null default 'other',
  lat             double precision,
  lng             double precision,
  description     text,
  visit_minutes   int,                            -- typical time spent
  opening_hours   jsonb,                          -- {"mon": ["06:00","18:00"], ...}
  entrance_fee_php numeric(8,2),
  created_at      timestamptz not null default now()
);

-- One leg from a terminal or spot to a spot (or back to a terminal)
create table last_mile_routes (
  id                uuid primary key default gen_random_uuid(),
  city              text not null default 'Baguio',
  from_terminal_id  uuid references terminals(id),
  from_spot_id      uuid references spots(id),
  to_terminal_id    uuid references terminals(id),
  to_spot_id        uuid references spots(id),
  mode              last_mile_mode not null,
  signboard         text,                         -- jeep signboard text
  boarding_point    text,                         -- where to catch it
  alighting_point   text,                         -- where to get off
  fare_min_php      numeric(8,2),
  fare_max_php      numeric(8,2),
  minutes           int,
  source            data_source not null default 'manual',
  last_verified_at  timestamptz,
  notes             text,
  created_at        timestamptz not null default now(),
  constraint lmr_one_origin check (num_nonnulls(from_terminal_id, from_spot_id) = 1),
  constraint lmr_one_destination check (num_nonnulls(to_terminal_id, to_spot_id) = 1),
  constraint lmr_fare_range check (fare_max_php is null or fare_min_php is null or fare_max_php >= fare_min_php)
);

-- ---------------------------------------------------------------------------
-- Saved itineraries (AI planner output) with a share link
-- ---------------------------------------------------------------------------
create table itineraries (
  id            uuid primary key default gen_random_uuid(),
  share_slug    text unique not null default encode(gen_random_bytes(6), 'hex'),
  trip_date     date not null,
  return_date   date,
  party         jsonb not null,                   -- [{"type":"adult","name":"Jacob"}, ...]
  budget_php    numeric(10,2),
  vibe          text,                             -- 'food trip', 'chill', 'nature'
  plan          jsonb not null,                   -- validated planner output (see shape below)
  model         text,                             -- which LLM produced it
  created_at    timestamptz not null default now()
);

-- Expected plan shape (validated in FastAPI before insert):
-- {
--   "outbound": {"trip_id": "<uuid>", "date": "2026-11-06"},
--   "return":   {"trip_id": "<uuid>", "date": "2026-11-08"},
--   "days": [
--     {"day": 1, "stops": [
--       {"spot_id": "<uuid>", "arrive": "13:00", "leave": "15:00",
--        "leg": {"last_mile_route_id": "<uuid>"}}
--     ]}
--   ]
-- }

-- ---------------------------------------------------------------------------
-- Shared trip wallets (TG-50): who paid what on the trip, and who pays whom at the end.
-- Private by link: no public policy; the API serves a wallet by its share_slug. Money is whole centavos.
-- Payout QRs are never stored here: they stay on each person's phone.
-- ---------------------------------------------------------------------------
create table wallets (
  id            uuid primary key default gen_random_uuid(),
  share_slug    text unique not null default encode(gen_random_bytes(16), 'hex'),  -- 128 bits: the link is the key
  name          text not null check (char_length(name) between 1 and 40),
  created_at    timestamptz not null default now()
);

create table wallet_members (
  id            uuid primary key default gen_random_uuid(),
  seq           bigint generated always as identity,  -- keeps the party in the order it was entered
  wallet_id     uuid not null references wallets(id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 30),
  created_at    timestamptz not null default now()
);
create unique index wallet_members_name on wallet_members (wallet_id, lower(name));

create table expenses (
  id              uuid primary key default gen_random_uuid(),
  wallet_id       uuid not null references wallets(id) on delete cascade,
  paid_by         uuid not null references wallet_members(id) on delete cascade,
  amount_centavos integer not null check (amount_centavos between 1 and 10000000),  -- up to PHP 100,000
  note            text not null check (char_length(note) between 1 and 60),
  created_at      timestamptz not null default now()
);
create index expenses_wallet on expenses (wallet_id);

-- Each person's part of an expense; the parts add up to amount_centavos (checked in the API)
create table expense_shares (
  expense_id      uuid not null references expenses(id) on delete cascade,
  member_id       uuid not null references wallet_members(id) on delete cascade,
  share_centavos  integer not null check (share_centavos >= 0),
  primary key (expense_id, member_id)
);

-- A payment between two people that the group marked as done
create table settlements (
  id              uuid primary key default gen_random_uuid(),
  wallet_id       uuid not null references wallets(id) on delete cascade,
  from_member     uuid not null references wallet_members(id) on delete cascade,
  to_member       uuid not null references wallet_members(id) on delete cascade,
  amount_centavos integer not null check (amount_centavos between 1 and 10000000),
  created_at      timestamptz not null default now(),
  check (from_member <> to_member)
);
create index settlements_wallet on settlements (wallet_id);

-- ---------------------------------------------------------------------------
-- Search view: one row per active trip, flattened for the API
-- ---------------------------------------------------------------------------
-- security_invoker keeps the view under the same RLS rules as its tables (Supabase flags views without it)
create view trip_search with (security_invoker = true) as
select
  t.id                 as trip_id,
  o.slug               as operator_slug,
  o.name               as operator_name,
  ot.slug              as origin_slug,
  ot.name              as origin_name,
  ot.city              as origin_city,
  dt.slug              as destination_slug,
  dt.name              as destination_name,
  dt.city              as destination_city,
  r.via,
  r.class,
  r.fare_php,
  r.travel_minutes,
  t.departure_time,
  t.days_of_week,
  t.valid_from,
  t.valid_to,
  coalesce(r.booking_url, o.booking_url) as booking_url,
  t.source,
  t.source_url,
  t.last_verified_at
from trips t
join routes r     on r.id = t.route_id
join operators o  on o.id = r.operator_id
join terminals ot on ot.id = r.origin_terminal_id
join terminals dt on dt.id = r.destination_terminal_id
where t.is_active;

-- Keep updated_at fresh on trips
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger trips_touch before update on trips
for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security
-- Reference data is public read; itineraries and trip_reports are API-only.
-- Writes go through the FastAPI service role.
-- ---------------------------------------------------------------------------
alter table operators          enable row level security;
alter table terminals          enable row level security;
alter table operator_terminals enable row level security;
alter table routes             enable row level security;
alter table trips              enable row level security;
alter table trip_reports       enable row level security;
alter table spots              enable row level security;
alter table last_mile_routes   enable row level security;
alter table itineraries        enable row level security;
alter table wallets            enable row level security;
alter table wallet_members     enable row level security;
alter table expenses           enable row level security;
alter table expense_shares     enable row level security;
alter table settlements        enable row level security;

create policy public_read on operators          for select using (true);
create policy public_read on terminals          for select using (true);
create policy public_read on operator_terminals for select using (true);
create policy public_read on routes             for select using (true);
create policy public_read on trips              for select using (true);
create policy public_read on spots              for select using (true);
create policy public_read on last_mile_routes   for select using (true);
-- trip_reports: no public policy yet (service role only)
-- itineraries: no public policy (TG-32). Party names are private; share links are served by the API.
-- wallets, wallet_members, expenses, expense_shares, settlements: no public policy (TG-50). Same as itineraries.

-- ---------------------------------------------------------------------------
-- Seed: operators and terminals for the MVP
-- Coordinates left null: fill from Google Maps when you curate.
-- ---------------------------------------------------------------------------
insert into operators (slug, name, booking_notes) values
  ('victory-liner', 'Victory Liner', 'Sells on its own site and on aggregators; aggregator inventory may be incomplete'),
  ('genesis',       'Genesis Transport / Joy Bus', 'Schedules posted on Facebook; online booking via its partner sites'),
  ('solid-north',   'Pangasinan Solid North Transit', 'Own site plus 12Go and Klook');

insert into terminals (slug, name, city) values
  ('vl-cubao',      'Victory Liner Cubao',     'Quezon City'),
  ('vl-pasay',      'Victory Liner Pasay',     'Pasay'),
  ('vl-caloocan',   'Victory Liner Caloocan',  'Caloocan'),
  ('vl-sampaloc',   'Victory Liner Sampaloc',  'Manila'),
  ('gen-cubao',     'Genesis Cubao',           'Quezon City'),
  ('gen-pasay',     'Genesis Pasay',           'Pasay'),
  ('gen-avenida',   'Genesis Avenida',         'Manila'),
  ('sn-cubao',      'Solid North Cubao',       'Quezon City'),
  ('pitx',          'PITX',                    'Paranaque'),
  ('vl-baguio',     'Victory Liner Baguio',    'Baguio'),
  ('gen-baguio',    'Genesis Baguio (Gov. Pack Rd)',     'Baguio'),
  ('sn-baguio',     'Solid North Baguio (Gov. Pack Rd)', 'Baguio');

insert into operator_terminals (operator_id, terminal_id)
select o.id, t.id from operators o join terminals t on
  (o.slug = 'victory-liner' and t.slug in ('vl-cubao','vl-pasay','vl-caloocan','vl-sampaloc','vl-baguio')) or
  (o.slug = 'genesis'       and t.slug in ('gen-cubao','gen-pasay','gen-avenida','gen-baguio')) or
  (o.slug = 'solid-north'   and t.slug in ('sn-cubao','pitx','sn-baguio'));

-- ---------------------------------------------------------------------------
-- Example: entering one route and its trips by hand
-- Replace times and fares with what you verify on the operator's site.
-- ---------------------------------------------------------------------------
-- with r as (
--   insert into routes (operator_id, origin_terminal_id, destination_terminal_id, via, class, fare_php, travel_minutes, seat_layout)
--   select o.id, a.id, b.id, 'Luisita', 'regular_aircon', null, 360, '2x2'
--   from operators o, terminals a, terminals b
--   where o.slug = 'victory-liner' and a.slug = 'vl-cubao' and b.slug = 'vl-baguio'
--   returning id
-- )
-- insert into trips (route_id, departure_time, source, source_url, last_verified_at)
-- select r.id, v.t::time, 'manual', 'https://www.victoryliner.com', now()
-- from r, (values ('07:00'), ('09:30'), ('12:00')) as v(t);
