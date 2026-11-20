-- TG-64 The read-only recap link (owner-approved 2026-11-16, options.md §3): null until someone with the trip's link
-- turns it on, and what it shows. Safe to re-run: each check is on its column, so `add column if not exists` skips it
-- too. A no-op on a database built from schema.sql. trip_sessions already has RLS on, with no policy.
alter table trip_sessions add column if not exists recap_slug     text unique check (recap_slug ~ '^[0-9a-f]{32}$');  -- null = off
alter table trip_sessions add column if not exists recap_photos   boolean not null default false;
alter table trip_sessions add column if not exists recap_people   text not null default 'none' check (recap_people in ('none', 'names', 'names_photos'));
alter table trip_sessions add column if not exists recap_spending text not null default 'none' check (recap_spending in ('none', 'total'));
