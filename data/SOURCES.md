# Data sources

Every agent-researched row is marked `agent-researched (tg-data), owner to verify`. Dates are Manila time.

## Terminals (`supabase/data/terminals_coords.sql`), checked 2026-10-29

Coordinates come from Nominatim's point for each OpenStreetMap element (the centroid for an area), from one call to `https://nominatim.openstreetmap.org/lookup` (format=jsonv2, addressdetails=1). Tags were checked with the Overpass API.

| Slug | Source | Note |
| --- | --- | --- |
| `vl-cubao` | https://www.openstreetmap.org/relation/20397506 | `amenity=bus_station`, branch Cubao, on EDSA |
| `vl-pasay` | https://www.openstreetmap.org/way/937784681 | 651 EDSA. OSM tags it `was:amenity=bus_station` (now a depot); a "Victory Liner Pasay Terminal" stop is about 40 m away (node/255067127). Owner to confirm. |
| `vl-caloocan` | https://www.openstreetmap.org/way/837697670 | 713 Rizal Avenue Extension |
| `vl-caloocan` | https://www.victoryliner.com/GeneralInquiries.aspx | The page footer gives the same address, 713 Rizal Avenue Extension, Caloocan City 1400 |
| `vl-sampaloc` | https://www.openstreetmap.org/way/179381146 | M. Earnshaw Street |
| `gen-cubao` | https://www.openstreetmap.org/way/1149427127 | `amenity=bus_station` on EDSA. The "North Genesis Cubao" building (way/146590356) is mapped as mostly a drop-off area, so it isn't used. |
| `gen-pasay` | https://www.openstreetmap.org/node/3545972726 | The OSM description says "revival ongoing until permanent closure" (LRT-1 extension). Owner to confirm it still operates. |
| `gen-avenida` | https://www.openstreetmap.org/way/89418673 | Doroteo Jose Street, operator Genesis Transport Service |
| `sn-cubao` | https://www.openstreetmap.org/way/1149427130 | "Solid North Transit Inc." `amenity=bus_station` on EDSA |
| `pitx` | https://www.openstreetmap.org/relation/18332894 | 1 Kennedy Road, Tambo, Parañaque |
| `vl-baguio` | https://www.openstreetmap.org/way/191045739 | Utility Road terminal, destinations Caloocan, Cubao, Sampaloc, Pasay. Not the VL ticket booth on Governor Pack Road (node/4153839117). |
| `gen-baguio` | https://www.openstreetmap.org/node/2012401455 | Governor Pack Road |
| `sn-baguio` | https://www.openstreetmap.org/node/1693819088 | "Pangasinan Solid North Bus Terminal", Governor Pack Road |

Not used:
- `genesistransport.com.ph`: robots.txt disallows all crawling.
- `solidnorth.com.ph`: the domain did not resolve.
- The Victory Liner "Terminal Directory" loads by script and isn't in the static page, so only the Caloocan footer address was used.

## Lodging (`data/spots.csv`, `data/last_mile_routes.csv`), checked 2026-10-29
| Row | Source | Note |
| `finteo-skylands-premium` name, address, lat/lng | https://www.gites.fr/gites_finteo-skylands-premium_baguio_h5844590_en.htm | Lists "Finteo Skylands Premium, 96 Doctor Carino Street - 2600 BAGUIO" and "GPS coordinates : 16.40823, 120.59035". Read with WebFetch; a direct request got a CloudFront 403, which I didn't work around. |
| `finteo-skylands-premium` address | https://www.laterooms.com/en-us/hotel/baguio/finteo-skylands-premium | Same address, "96 Doctor Carino Street, Baguio, 2600". No coordinates. |
| Cross-check | https://www.openstreetmap.org/way/299949902 | OSM maps a separate listing, "Finteo Skylands" (apartments, Dr. Jose Cariño Street), about 42 m from the Premium GPS point. https://m.hotele.pl/en/philippines/baguio/finteo-skylands gives that one as "99 Finteo Skylands, Dr. Cariño". The two are different listings on the same street, so the owner should check the booking to confirm which one it is. |
| 6 taxi legs, each Baguio terminal to and from the lodging | none | No source gave a jeep signboard, fare or travel time, so these are taxi legs with fare and minutes left empty. Straight-line distances (not travel times) are 1.3 km to `vl-baguio`, 0.9 km to `gen-baguio` and 0.85 km to `sn-baguio`. |
- Booking.com (`/hotel/ph/finteo-skylands-premium.html`): returns an empty page without JavaScript.
- tophotels.com: 404.

## Spots and last-mile legs (`data/spots.csv`, `data/last_mile_routes.csv`), checked 2026-10-29

Coordinates come from Nominatim's point for each OpenStreetMap element, from one call to `https://nominatim.openstreetmap.org/lookup` (format=jsonv2, extratags=1). The OSM element for each spot is in the `#` comment row above it in `spots.csv`. Descriptions only state what OSM or the official site says (street, municipality).

| Spot | OSM element | Note |
| --- | --- | --- |
| `burnham-park` | way/330642136 | `leisure=park` |
| `session-road` | node/2131877654 | The point of the Session Road barangay (`place=quarter`), not a single address on the street |
| `baguio-city-market` | way/224613128 | `amenity=marketplace`, Kayang Street area |
| `mines-view-park` | way/109351462 | Outlook Drive |
| `wright-park` | relation/12714120 | |
| `the-mansion` | relation/7918303 | "The Mansion Compound", V. L. Romulo Drive |
| `baguio-botanical-garden` | relation/14181288 | Leonard Wood Road, operator City Environment and Parks Management Office |
| `camp-john-hay` | node/8595268914 | Neighbourhood point inside a large area; pick a gate or attraction if the planner needs one |
| `bencab-museum` | way/112289880 | 91 Asin Road, Tuba, Benguet |
| `baguio-cathedral` | way/42936372 | Father Carlu Street |
| `good-shepherd-convent` | node/384142750 | "Good Shepherd Sisters Convent", `shop=confectionery`, Dominica Lane |
| `la-trinidad-strawberry-farm` | relation/7917267 | La Trinidad, Benguet; owner Benguet State University |
| `tam-awan-village` | way/209022152 | 366 C Longlong Road. Two other "Tam-Awan" points in OSM (node/11019905799, node/11378230771) were not used. |

Hours and fees:
- `bencab-museum`: https://bencabmuseum.org/location-info/ (official). "Tuesdays to Sundays 9:00am to 6:00pm (last entry at 5:30pm) Closed Mondays, Christmas day and New Year's day", "Php 200 – General admission" (Php 150 senior/PWD, Php 120 student). The page was last modified 2023-01-08, so the owner should check the fee is still current.
- All other spots: no official fee or hours page found, so `entrance_fee_php` is empty. `visit_minutes` is empty for every spot because no source gave a typical visit length. `spots.csv` has no opening-hours column, so BenCab's hours are in its description.

Leads only, not loaded (OSM tags, not an approved fee source): Mines View Park `fee=10 PHP` (`5 PHP` age 3 to 12), Botanical Garden `charge=100 PHP` (check_date 2023-11-22), Tam-awan Village `charge=60 PHP`; opening_hours tags on the market, Mines View, Botanical Garden, Cathedral and Tam-awan.

Jeep legs:
- https://www.backpackingphilippines.com/2022/05/how-to-commute-in-baguio-jeepney-routes.html (a 2022 guide). Says the "Baguio Plaza - Mines View and vice versa" route (Teachers Camp, Baguio Botanical Garden, Wright Park, The Mansion, Good Shepherds Convent, Mines View Park) loads on Gov. Pack Road, and that Strawberry Farm is by "jeepney to La Trinidad (terminal corner of Magsaysay and T. Alonzo Street)". That gives 10 legs from `gen-baguio` and `sn-baguio` (both on Gov. Pack Road) to the five spots on the route, and 1 leg from `baguio-city-market` to `la-trinidad-strawberry-farm`. The start points are my choice of the nearest terminal or spot to each loading area; the owner should verify them. The signboard is the route name as the guide writes it; the exact text on the jeep, the fares and the times are not confirmed.
- The guide cites an official Baguio City notice (https://www.baguio.gov.ph/content/city-assigns-new-loading-staging-areas-pujs). I couldn't read it: the www host serves a certificate for a different name (`convease-test.baguio.gov.ph`), and `new.baguio.gov.ph` returns 404 for that path. I didn't bypass the certificate check.
- Camp John Hay ("Baguio Plaza - Scout Barrio") and Tam-awan ("Baguio Plaza - Quezon Hill - Tam-awan") have a route name but no boarding point in the guide, so they have no jeep legs. Blog tips about Kayang Street (Tam-awan, BenCab) were not fetched from a reputable source and aren't used.

Taxi legs: 26 legs, from `finteo-skylands-premium` to each spot and back. No fare or minutes, matching batch 2. There are no spot-to-spot legs yet (see the open question in the handoff).

Not used:
- `tam-awanvillage.com` (with a hyphen) now hosts contractor and kitchen-remodel pages, so the domain has changed hands. The official site is `tamawanvillage.com` (linked from OSM), and it has no fees or hours.
- `campjohnhay.ph` redirects to John Hay Hotels, not the park's management.
- Travel blogs and aggregators with conflicting fee figures.

## Taxi mesh (`data/last_mile_routes.csv`, branch DATA-taxi-mesh), generated 2026-10-29

155 generated taxi legs, one for every ordered pair of the 13 spots, minus `baguio-city-market` → `la-trinidad-strawberry-farm`, which a sourced jeep leg already covers (the reverse direction is included). Legs to and from the lodging already exist as taxi legs, so none are added here. Fare and minutes are empty. Each leg's note reads "generic metered taxi between Baguio-area spots (manager-approved generated leg, not a sourced route); owner to verify". tg-manager approved this on 2026-10-29 because the planner validator chains each leg from the previous stop. It is a separate PR so the owner can drop it with one revert.

No source URL:
- `last_mile_routes.csv` has no `source_url` column, so a source could only be cited here.
- A search on 2026-10-29 found no official city or tourism page saying metered taxis serve these areas. Results were news reports about LTFRB taxi fare changes (Inquirer, SunStar, PTV, 2010 to 2018 plus one undated P50 flag-down report), which don't state coverage and aren't current fare sources, so none is cited.

## Pre-made itineraries (`data/premade_itineraries.json`), authored 2026-10-29

Three plans for the owner's trip (Victory Liner from Cubao on Fri 2026-11-06, back to Cubao on Sun 2026-11-08): `food-trip`, `chill` and `nature`. They use only rows already in the database:
- Trips: from a run of `scraper/victory_liner.py` against the public Victory Liner API (https://tickets.victoryliner.com) on 2026-10-29, which fetches the next 14 days. Outbound trips are deluxe 07:00, first class 08:15 and first class 06:15 (arriving 10:15 to 12:15). Returns are first class 16:15, first class 14:15 and royal class 15:15 (arriving in Cubao 18:15 to 20:15). Each plan's last stop leaves at least 30 minutes before its return bus.
- Spots and legs: the merged rows in this file's sections above. Every leg is a generated taxi leg except the sourced La Trinidad jeep (market to Strawberry Farm) in `food-trip`.
- Day 1 starts with the taxi from `vl-baguio` to the lodging, and days 1 and 2 end at the lodging, so days 2 and 3 start there.

Not sourced (the owner should adjust): the stop times are planning choices, not travel times, because no leg has minutes. The party (one adult) and the empty budget are placeholders. BenCab visits are within its official Tuesday to Sunday 9:00 to 18:00 hours. Re-run `python data/load_premade.py --dry-run` after each scraper run, because a deactivated trip breaks a plan.
