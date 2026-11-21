-- Sagada operator and terminals (TG-67, DATA-sagada). Data only: no table change.
-- Run after schema.sql, before data/load_data.py loads the Sagada rows:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/data/sagada_seed.sql
-- Safe to re-run: rows are upserted by slug.
--
-- Sources (every one is listed in data/SOURCES.md, "Sagada"), checked 2026-11-20 (Manila):
-- - Operator and stations: https://www.codalines.ph/ and https://www.codalines.ph/stations (official site).
-- - Coordinates: Nominatim's point for each OpenStreetMap element (https://nominatim.openstreetmap.org/lookup).
-- agent-researched (tg-data), owner to verify.

begin;

insert into operators (slug, name, website_url, booking_url, booking_notes) values
  ('coda-lines', 'Coda Lines', 'https://www.codalines.ph/',
   'https://codalines.12go.com/en/travel/quezon-city/sagada',
   'Student, senior citizen and PWD discounts are sold only at the terminal ticket booths (ID check). Limited trips online.')
on conflict (slug) do update set
  name = excluded.name, website_url = excluded.website_url, booking_url = excluded.booking_url,
  booking_notes = excluded.booking_notes;

insert into terminals (slug, name, city, address, lat, lng, notes) values
  -- https://www.openstreetmap.org/node/10100751717 ("Coda Lines Terminal", amenity=bus_station)
  ('coda-cubao', 'Coda Lines Cubao (HM Transport terminal)', 'Quezon City',
   'HM Transport Terminal, Monte de Piedad St. corner Maryland St., Brgy. Immaculate Concepcion, Quezon City',
   14.623332, 121.048740,
   'agent-researched (tg-data), owner to verify. Address from codalines.ph/stations. OSM node/10100751717, checked 2026-11-20. The "HM Transport Cubao" stop (node/1649835257) is about 15 m away.'),
  -- https://www.openstreetmap.org/node/5566017629 ("Bus Stop", amenity=bus_station, beside the Municipal Hall)
  ('coda-sagada', 'Sagada Municipal Hall stop (Coda Lines)', 'Sagada',
   'In front of the Sagada Municipal Hall, Poblacion, Sagada, Mountain Province',
   17.084425, 120.900279,
   'agent-researched (tg-data), owner to verify. "Poblacion, Sagada" on codalines.ph/stations; the owner''s itinerary says the bus stops in front of the Municipal Hall. OSM node/5566017629, checked 2026-11-20. The OSM "Coda Lines Booking Office" (node/4838253221) is about 7 m away.')
on conflict (slug) do update set
  name = excluded.name, city = excluded.city, address = excluded.address,
  lat = excluded.lat, lng = excluded.lng, notes = excluded.notes;

insert into operator_terminals (operator_id, terminal_id)
select o.id, t.id from operators o join terminals t on t.slug in ('coda-cubao', 'coda-sagada')
where o.slug = 'coda-lines'
on conflict do nothing;

commit;

-- Rollback (TG-67 plan §8). Run by hand, in one transaction, only after each count shows that no itinerary uses
-- the rows (check plan->'outbound'/'return' trip ids and the guide's bus rows and places first).
--
-- begin;
-- select count(*) from itineraries i where i.plan::text like any (array(
--   select '%' || id || '%' from trips where route_id in (select r.id from routes r join operators o on o.id = r.operator_id where o.slug = 'coda-lines')
--   union all select '%' || id || '%' from spots where city = 'Sagada'
--   union all select '%' || id || '%' from last_mile_routes where city = 'Sagada'));   -- must be 0
-- delete from last_mile_routes where city = 'Sagada';
-- delete from spots where city = 'Sagada';
-- delete from trips where route_id in (select r.id from routes r join operators o on o.id = r.operator_id where o.slug = 'coda-lines');
-- delete from routes where operator_id = (select id from operators where slug = 'coda-lines');
-- delete from operator_terminals where operator_id = (select id from operators where slug = 'coda-lines');
-- delete from terminals where slug in ('coda-cubao', 'coda-sagada');
-- delete from operators where slug = 'coda-lines';
-- commit;
