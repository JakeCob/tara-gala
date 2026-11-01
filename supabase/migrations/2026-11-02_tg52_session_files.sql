-- TG-52 PR 2: shared trip files (tickets, payout QRs, the hotel's screenshot). See schema.sql for the commented
-- definition. Private by link: RLS on with no policy; the API reads and writes through DATABASE_URL, and the bytes
-- live in the private Storage bucket "trip-files". Safe to re-run, and a no-op on a database built from schema.sql.

-- Files the party shares on a trip (TG-52 PR 2): bus tickets, each person's payout QR and the hotel's booking
-- screenshot (photos come in PR 4). The bytes live in a private Supabase Storage bucket at storage_path
-- ("<session id>/<file id>"); the API serves them to people with the trip's link. Tickets, QRs and the hotel
-- screenshot are deleted 14 days after the trip (delete_after); photos stay until someone deletes them.
create table if not exists session_files (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references trip_sessions(id) on delete cascade,
  kind          text not null check (kind in ('ticket', 'payout_qr', 'hotel_proof', 'photo')),
  member_id     uuid references wallet_members(id) on delete cascade,  -- whose payout QR
  label         text not null default '' check (char_length(label) <= 40),
  storage_path  text unique not null,
  content_type  text not null check (content_type in ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  bytes         integer not null check (bytes between 1 and 5242880),  -- up to 5 MB
  delete_after  date,
  created_at    timestamptz not null default now(),
  check ((kind = 'payout_qr') = (member_id is not null))
);
create index if not exists session_files_session on session_files (session_id);
create unique index if not exists session_files_one_qr on session_files (session_id, member_id) where kind = 'payout_qr';
create unique index if not exists session_files_one_proof on session_files (session_id) where kind = 'hotel_proof';

alter table session_files enable row level security;
