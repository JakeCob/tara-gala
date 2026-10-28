-- TG-32: itineraries must not be publicly listable.
-- The public_read policy let anyone with the anon key read every saved plan, including party names.
-- RLS stays enabled with no policy, so anon and authenticated see nothing; the API reads through DATABASE_URL
-- (table owner, not subject to RLS). Share links (GET /itineraries/{share_slug}, TG-23) go through the API.
-- Safe to re-run, and a no-op on a database built from the current schema.sql.
drop policy if exists public_read on public.itineraries;
