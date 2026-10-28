-- Terminal addresses and coordinates for the 12 seeded terminals (TG-7).
-- Run after schema.sql:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/data/terminals_coords.sql
-- Safe to re-run: rows are updated by slug. Nothing is inserted.
--
-- Source: OpenStreetMap. Coordinates are Nominatim's point for each OSM element (the centroid for an area),
-- fetched 2026-10-29 (Manila) via https://nominatim.openstreetmap.org/lookup. Addresses are from the
-- element's addr:* tags plus Nominatim's address hierarchy. Every source is listed in data/SOURCES.md.
-- agent-researched (tg-data), owner to verify.

begin;

update terminals t set
  address = v.address,
  lat     = v.lat,
  lng     = v.lng,
  notes   = v.notes
from (values
  -- https://www.openstreetmap.org/relation/20397506 (amenity=bus_station, branch=Cubao)
  ('vl-cubao', 'EDSA, Pinagkaisahan, Cubao, Quezon City 1111', 14.624144, 121.048319,
   'agent-researched (tg-data), owner to verify. OSM relation/20397506, checked 2026-10-29.'),
  -- https://www.openstreetmap.org/way/937784681 (tagged was:amenity=bus_station, depot=bus)
  ('vl-pasay', '651 EDSA, Barangay 143, Pasay 1300', 14.539240, 121.007127,
   'agent-researched (tg-data), owner to verify. OSM way/937784681, checked 2026-10-29. OSM tags this site as a former bus station (now a depot); a "Victory Liner Pasay Terminal" stop is mapped about 40 m away (node/255067127).'),
  -- https://www.openstreetmap.org/way/837697670; address also on https://www.victoryliner.com/GeneralInquiries.aspx
  ('vl-caloocan', '713 Rizal Avenue Extension, Grace Park West, Caloocan 1400', 14.655997, 120.983249,
   'agent-researched (tg-data), owner to verify. OSM way/837697670, checked 2026-10-29. Address matches the Victory Liner website footer.'),
  -- https://www.openstreetmap.org/way/179381146
  ('vl-sampaloc', 'M. Earnshaw Street, Sampaloc, Manila 1008', 14.604192, 120.992554,
   'agent-researched (tg-data), owner to verify. OSM way/179381146, checked 2026-10-29.'),
  -- https://www.openstreetmap.org/way/1149427127 (the separate "North Genesis Cubao" building is mapped as mostly a drop-off area)
  ('gen-cubao', 'EDSA, E. Rodriguez Sr., Cubao, Quezon City 1102', 14.625636, 121.048695,
   'agent-researched (tg-data), owner to verify. OSM way/1149427127, checked 2026-10-29.'),
  -- https://www.openstreetmap.org/node/3545972726
  ('gen-pasay', 'Don Carlos Revilla Road, Barangay 146, Pasay 1303', 14.536337, 121.001076,
   'agent-researched (tg-data), owner to verify. OSM node/3545972726, checked 2026-10-29. OSM description: "Post-pandemic revival ongoing until permanent closure due to LRT-1 South Extension opening towards PITX"; confirm it still operates.'),
  -- https://www.openstreetmap.org/way/89418673
  ('gen-avenida', 'Doroteo Jose Street, Santa Cruz, Manila 1003', 14.604924, 120.982491,
   'agent-researched (tg-data), owner to verify. OSM way/89418673, checked 2026-10-29.'),
  -- https://www.openstreetmap.org/way/1149427130
  ('sn-cubao', 'EDSA, Immaculate Concepcion, Cubao, Quezon City 1111', 14.623644, 121.048540,
   'agent-researched (tg-data), owner to verify. OSM way/1149427130, checked 2026-10-29.'),
  -- https://www.openstreetmap.org/relation/18332894
  ('pitx', '1 Kennedy Road, Tambo, Parañaque 1701', 14.509965, 120.991373,
   'agent-researched (tg-data), owner to verify. OSM relation/18332894, checked 2026-10-29.'),
  -- https://www.openstreetmap.org/way/191045739 (destinations listed: Caloocan, Cubao, Sampaloc, Pasay)
  ('vl-baguio', 'Utility Road, Bal Marcoville, Baguio 2600', 16.405701, 120.602487,
   'agent-researched (tg-data), owner to verify. OSM way/191045739, checked 2026-10-29. Not the Victory Liner ticket booth on Governor Pack Road (node/4153839117).'),
  -- https://www.openstreetmap.org/node/2012401455
  ('gen-baguio', 'Governor Pack Road, Baguio 2600', 16.410282, 120.598534,
   'agent-researched (tg-data), owner to verify. OSM node/2012401455, checked 2026-10-29.'),
  -- https://www.openstreetmap.org/node/1693819088
  ('sn-baguio', 'Governor Pack Road, Baguio 2600', 16.409742, 120.598130,
   'agent-researched (tg-data), owner to verify. OSM node/1693819088, checked 2026-10-29.')
) as v(slug, address, lat, lng, notes)
where t.slug = v.slug;

-- Every seeded terminal must now have coordinates; a missing seed aborts the whole file.
do $$
declare missing text;
begin
  select string_agg(s, ', ') into missing
  from unnest(array['vl-cubao','vl-pasay','vl-caloocan','vl-sampaloc','gen-cubao','gen-pasay','gen-avenida',
                    'sn-cubao','pitx','vl-baguio','gen-baguio','sn-baguio']) as s
  where not exists (select 1 from terminals where slug = s and lat is not null and lng is not null);
  if missing is not null then
    raise exception 'terminals_coords.sql: no coordinates for %', missing;
  end if;
end $$;

commit;
