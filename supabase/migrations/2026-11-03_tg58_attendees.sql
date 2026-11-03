-- TG-58 Attendees, arrival, profile photos and the limited invite (owner-approved 2026-11-03). Safe to re-run, and a no-op
-- on a database built from schema.sql.
alter table trip_sessions add column if not exists invite_slug text unique check (invite_slug ~ '^[0-9a-f]{32}$');

create table if not exists session_attendees (
  id          uuid primary key default gen_random_uuid(),
  seq         bigint generated always as identity,  -- keeps the list in the order it was entered
  session_id  uuid not null references trip_sessions(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 30),
  rsvp        text not null default 'pending' check (rsvp in ('pending', 'yes', 'no')),
  rsvp_at     timestamptz,
  arrived_at  timestamptz,  -- at the first meet-up
  created_at  timestamptz not null default now(),
  check ((rsvp = 'pending') = (rsvp_at is null))
);
create unique index if not exists session_attendees_name on session_attendees (session_id, lower(name));
alter table session_attendees enable row level security;

alter table session_files add column if not exists attendee_id uuid references session_attendees(id) on delete cascade;
alter table session_files drop constraint if exists session_files_kind_check;
alter table session_files add constraint session_files_kind_check check (kind in ('ticket', 'payout_qr', 'hotel_proof', 'photo', 'avatar'));
alter table session_files drop constraint if exists session_files_avatar_attendee;
alter table session_files add constraint session_files_avatar_attendee check ((kind = 'avatar') = (attendee_id is not null));
create unique index if not exists session_files_one_avatar on session_files (attendee_id) where kind = 'avatar';
