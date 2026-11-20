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

## Owner's booked buses (`data/routes_trips.csv`), added 2026-11-03

Two manual one-off Victory Liner first class trips, approved by the owner (TG-59): `vl-cubao` to `vl-baguio` on Fri 2026-11-06 at 10:15, and `vl-baguio` to `vl-cubao` on Sun 2026-11-08 at 16:15. They are backed by the owner's own e-tickets, which stay private and are not in this repo. `source_url` is the operator's site, https://tickets.victoryliner.com/. Fare (1,151) and travel time (240 minutes) are the route's values. These are the only rows here not taken from a public schedule. The return had no row in the Nov 2 scrape, most likely because it is sold out.

## Trips Victory Liner stopped listing (TG-59b), 2026-11-03

Victory Liner no longer lists first class 13:15 and 14:15 from Baguio to Cubao on Sun 2026-11-08, most likely because they sold out. So those two reference rows are gone from `getting_home` in `data/itineraries/baguio-barkada-2026-11-06.json`, and the `chill` plan is gone from `data/premade_itineraries.json` for now, because it used the 14:15 return and first class 08:15 on Nov 6, which no longer resolves either. `food-trip` and `nature` stay. The owner's booked rows are unchanged. The other reference rows can drop out the same way before the trip, so re-run both dry runs after each scrape.

## Sagada (TG-67, branch DATA-sagada), checked 2026-11-20

For the owner's Sagada trip (Wed Nov 25 to Sun Nov 29, two people), from the owner's itinerary (`_team/tickets/TG-67/owner-itinerary.txt`) and research. The rows go in the main files with `city` = `Sagada`:
- `data/spots.csv` (21 spots) and `data/last_mile_routes.csv` (59 legs) now have a last column, `city`. It's blank on every Baguio row, so the loader's default, `Baguio`, still applies. **Load them only after TG-67 S1** (the loader reads `city`). Before that, Sagada rows would be saved as `Baguio`.
- `supabase/data/sagada_seed.sql`: the `coda-lines` operator, the `coda-cubao` and `coda-sagada` terminals, and `operator_terminals`. These are upserts, safe to re-run, with a commented rollback block at the bottom. **Run it before `load_data.py`.** Without it, the dry run fails with "unknown operator 'coda-lines'" and "unknown terminal 'coda-sagada'".
- `data/routes_trips.csv`: the owner's outbound bus, plus the owner's return bus as two commented rows, one per class. The class waits for the owner (manager, 2026-11-20).
- `data/itineraries/sagada-trip-2026-11-25.json`: the S5 guide draft (share slug `sagada-trip-nov25`).

Validated on tg-testpg (database `tg_data_sagada`: schema, migrations and `terminals_coords.sql`, then `sagada_seed.sql` twice):
- `load_data.py --dry-run`: "spots: 38, trips: 3 (3 new routes), last-mile routes: 349". That's Baguio's 17, 2 and 290 plus Sagada's 21, 1 and 59.
- Loading with the 35-seater return row uncommented (a temp copy) works twice, and the second run adds nothing.
- `load_itinerary.py --dry-run` on the guide reports only "the outbound trip must go to Baguio" and "the return trip must leave from Baguio", which is TG-67 S2's change. With the validator's city set to `Sagada` in memory, it gives "Dry run OK … sagada-trip-nov25: 3 days, 26 rows, 11 to-dos".

### Sagada centre point (for TG-67 S3 `CITY_CENTRES`)

**17.084373, 120.900438**: Sagada Municipal Hall, https://www.openstreetmap.org/way/185305065 (`amenity=townhall`, at Staunton Road and South Road), from Nominatim's point. It's also the `sagada-town-centre` spot. The Coda Lines stop is 20 m away, and The Poor Traveler (2019) calls this junction the town's main bus stop.

### Operator, terminals and buses

| Item | Source | Note |
| --- | --- | --- |
| Coda Lines operator, booking link, discount note | https://www.codalines.ph/ | The official site. `codalines.com` now hosts an unrelated Japanese blog. The home page links to `codalines.12go.com` for booking, and says student, senior and PWD discounts are sold only at terminal ticket booths. |
| Stations | https://www.codalines.ph/stations | "Quezon City: HM Transport Terminal, Monte De Piedad St., corner Maryland St., Brgy. Immaculate Concepcion, Quezon City" and "Sagada, Mt. Province: Poblacion, Sagada, Mt. Province". The owner's itinerary says the bus stops in front of the Municipal Hall. |
| `coda-cubao` lat/lng | https://www.openstreetmap.org/node/10100751717 | "Coda Lines Terminal", `amenity=bus_station`, on Maryland Street. "HM Transport Cubao" (node/1649835257) is within 15 m. |
| `coda-sagada` lat/lng | https://www.openstreetmap.org/node/5566017629 | "Bus Stop", `amenity=bus_station`, beside the Municipal Hall. The OSM "Coda Lines Booking Office" (node/4838253221) is 7 m away. |
| Owner's buses: dates and times | the owner's tickets, via `owner-itinerary.txt` | Wed 2026-11-25 22:30 Cubao to Sagada (loaded), and Sat 2026-11-28 14:30 Sagada to Cubao (commented, class pending). The loader stores them as `source = manual`. Each row's note starts "Booked: from the owner's ticket". `source_url` is the operator's site, as with the Baguio booked rows. |
| Class, fare, travel time | https://pamasahe.com/routes/quezon-city-sagada-and-coda-lines-schedule-fares | "Last Updated September 2026". It lists 10:30 PM as "Bus 35" only, and 2:30 PM as "Bus 35 and 45". "Bus 35 seater with CR ₱1499.00", "Bus 45 seater without CR ₱1304.00", and "12 hours", which gives `travel_minutes` 720 (the owner's itinerary also says about 12 hours each way). It warns fares "may be higher" because of fuel prices. The owner's itinerary quotes an older Pamasahe range of ₱1,232 to ₱1,377, which the page no longer shows. |
| Class names | https://www.philippinebeaches.org/?p=15615 | Updated 2025-01-20. It calls the bus with a toilet "Super Deluxe (w/ toilet)" and the one without "Deluxe (w/o toilet)", which gives `super_deluxe` with `has_restroom` yes for the 35-seater, and `deluxe` with no restroom for the 45-seater. |

Not used for times or fares:
- The operator's own schedule image (https://www.codalines.ph/copy-of-our-routes, "As of March 26, 2022": QC > Sagada 9:00 PM, Sagada > QC 2:00 PM). It's stale, and the owner's tickets supersede it.
- `codalines.12go.com`: returns 403 to automated requests.
- Coda Lines' Facebook page: needs a login.
- BusTickets.ph and other aggregators.
- No other direct Manila–Sagada operator was found. GV Florida's official schedule (https://gvfloridatrans.com/page5.html) stops at Banaue/Bagabag.

### Lodging

| Row | Source | Note |
| --- | --- | --- |
| `kanip-aw-pines-view-lodge` name, address, check-in and check-out | https://uk.trip.com/hotels/sagada-hotel-detail-6118917/kanip-aw-pines-view-lodge | "Kanip Aw Pines View Lodge", "3WG2+VJ3, Kinlibed, … Sagada, Mountain Province". It also gives "Check-in: After 14:00", "Check-out: Before 12:00" and "Breakfast not provided". The owner's itinerary says check-in from 1 PM, so the owner should confirm with the lodge. |
| lat/lng | https://www.openstreetmap.org/way/314651066 | "Kanip-Aw Lodge", `tourism=hostel`, South Road (Nominatim point 17.077061, 120.901525). Trip.com's plus code 3WG2+VJ3 decodes to about 17.0772, 120.9016, within 20 m. |
| Walk legs to and from the lodge | the Trip.com page and the owner's itinerary | Trip.com's review summary says "Located within walking distance of town center and restaurants". The owner's plan walks from the tourism office to Kanip-aw. Notes give straight-line distances (the town centre is 810 m away). Walking time is not sourced. |

Agoda's page for the lodge is an empty JavaScript shell, so it wasn't used.

### Spots (`data/spots.csv`, city Sagada)

Coordinates come from Nominatim lookups for OSM elements found with Overpass queries over the Sagada area. Each spot's element is in the `#` row above it. The owner's plan uses the first 14.

| Spot | OSM element | Note |
| --- | --- | --- |
| `kanip-aw-pines-view-lodge` | way/314651066 | see Lodging |
| `sagada-town-centre` | way/185305065 | Municipal Hall, the centre point above |
| `sagada-tourist-info-center` | node/2612566236 | `tourism=information`, `information=office` |
| `yoghurt-house` | way/242949721 | `amenity=restaurant`, Sagada South Road |
| `lemon-pie-house` | way/235082932 | "Sagada Lemon Pie House", `amenity=cafe` |
| `church-of-st-mary-the-virgin` | way/224067711 | Anglican church |
| `echo-valley` | way/255575795 | `natural=wood` area, centroid |
| `hanging-coffins` | node/2918514080 | `tourism=attraction`, inside Echo Valley |
| `lake-danum` | way/32356334 | "Danum Lake", alt_name "Lake Banao". A separate "Banao Lake" (way/1168005572) is 300 m away; the owner should check which one guides use. |
| `marlboro-hill` | node/2613401106 | "Marlboro Country", `natural=peak` |
| `blue-soil-hills` | node/6284065689 | "Blue Soil", `tourism=viewpoint` |
| `sumaguing-cave` | node/2612600152 | "Sumaguing Cave Entrance". Two other entrance points (node/3858183159, node/4750698323) are within 150 m and weren't used. |
| `log-cabin-sagada` | node/4545732390 | "Log Cabin", `amenity=restaurant`, Sagada-Besao Road. The hotel "Log Cabin Inn" (way/300416423) is the same site. "Agape Log Cabin" (node/4842702223) is a different place. |
| `bomod-ok-falls` | node/12180043229 | `waterway=waterfall`. "Bomod-ok Falls Registration Area" is node/4311239792. |
| `saggas-guides-office` | node/2612566224 | "SAGGAS Information Office" (Sagada Genuine Guides Association) |
| `lumiang-burial-cave` | node/2612600116 | `natural=cave_entrance` |
| `kiltepan-viewpoint` | node/2613062949 | `tourism=viewpoint` |
| `bokong-falls` | node/8406298601 | `waterway=waterfall` |
| `sagada-pottery` | node/2613055699 | `amenity=arts_centre` |
| `ganduyan-museum` | node/2612566174 | `tourism=museum` |
| `sagada-public-market` | node/2612566228 | `amenity=marketplace` |

Fees, guides and times:
- Registration fee (`sagada-tourist-info-center`, `entrance_fee_php` 100): https://ptvnews.ph/?p=212052 (PTV/PNA, 2022-10-19) says "the town only charges a PHP100 registration fee for tourists, which already covers the environment fee". Guides from 2019 give P50. The town's site, https://sagada.gov.ph/, is "rebuilding" and has no content. The PNA originals returned 403 or 404.
- Rules: https://ptvnews.ph/sagada-braces-for-tourists-influx-issues-guidelines (PTV/PNA, 2019-02-14). Visitors register at the tourism office, and the official receipt is the entrance pass to the sites. Echo Valley, Sumaguing and Lumiang are short walks from town. Bomod-ok and Marlboro are reached by shuttle. Marlboro has a visitor cap. Don't touch coffins or photograph mass.
- Guide rates, durations and van fees: https://www.thepoortraveler.net/2019/04/sagada-itinerary-guide/ (2019) and https://www.philippinebeaches.org/?p=12965 (undated, header image 2024-06). Hanging Coffins tour P300 for 1 to 10 people, 1 hour (`visit_minutes` 60). Sumaguing guide P800 for 1 to 4 people, "around 2 hours" (`visit_minutes` 120). Marlboro guide P600; the Marlboro plus Blue Soil package is guide P1,600 for 1 to 5 people and transport P1,350 two-way, with the Blue Soil trek "around two hours". Bomod-ok guide P500 for 1 to 7 people plus a "P10" barangay fee (`entrance_fee_php` 10) and transport P500 to P650. Lake Danum transport P550 and "20 minutes away from the town proper". Kiltepan is listed as "Temporarily Closed". These are per group, so they stay in descriptions and notes.
- Not sourced: opening hours for every spot. Log Cabin's dinner hours conflict (the owner's doc says 6 PM; search snippets from Trip.com and TableAgent say 6:30 or 7 PM; Manila Bulletin and TableAgent returned 403), so the guide row says to call ahead. Visit times are empty for every spot except the two above. Leads that aren't loaded: OSM `opening_hours` on Lemon Pie House (`Mo-Su 08:00-21:00`).

### Getting-around legs (`data/last_mile_routes.csv`, city Sagada)

59 legs, `minutes` empty unless sourced, fares only in notes (they're per vehicle, not per person):
- **The owner's chain** (plan §5): `coda-sagada` → tourist office → lodge, and lodge to and from Yoghurt House, Lemon Pie House, the church, Sumaguing, Log Cabin and the town centre (walk). Also church → Echo Valley → Hanging Coffins → lodge (walk), Marlboro → Blue Soil (the guided trek), and van legs lodge ↔ Lake Danum (20 min), lodge → Marlboro, Blue Soil → lodge, and lodge ↔ Bomod-ok.
- **The town-centre hub** (earlier batch): walks to the tourist office, SAGGAS, church, market, museum, Yoghurt House, Log Cabin, Bokong Falls, Sumaguing and Lumiang, and vans to Lumiang and Kiltepan (15 min). There's also Lumiang → Sumaguing, the guided Cave Connection.
- Walking times aren't sourced, so the notes give OSM straight-line distances. Van legs say "Hired tour vehicle through the tourism office or SAGGAS". That's how both guides describe the transport fee; no public route is implied.
- No leg to `sagada-pottery`: no source says how to get there.
- Not used: the OSM "Jeepney Station to Bangaan and Bontoc" (way/255575797). It has no signboard, fare or time from any source.

### The guide draft (`data/itineraries/sagada-trip-2026-11-25.json`)

It follows the owner's itinerary row by row: the day tables (Thu, Fri, Sat; Wednesday night is in the getting-there tips, and Sunday's arrival in the getting-home tips), a brunch pick (Yoghurt House or Lemon Pie House), the rules as day tips, the packing list as to-dos, and the owner's sources. The core plan's stop times are planning choices taken from the owner's times, not travel times.

Budget rows, per person for two (`estimate` form "1,232 to 1,377"):
- `bus` 2,803 to 2,998: the outbound ₱1,499, plus the return at ₱1,304 or ₱1,499 (Pamasahe, Sept 2026).
- `lodge`: as booked.
- `registration` 100: PTV/PNA 2022.
- `guides` 1,610: half of (Hanging Coffins P300 + Marlboro and Blue Soil P1,600 + Sumaguing P800 + Bomod-ok P500), plus the P10 barangay fee, all at the 2019 guide rates above. The owner's itinerary says ~₱800 to ₱1,000 per tour for two.
- `vans` 925 to 1,000: half of (Marlboro and Blue Soil P1,350 + Bomod-ok P500 to P650). The owner's file doesn't have this row; it's added because both guides charge transport on top of guide fees.
- `danum` 275: half of P550.
- `food`: "Your call", as in the owner's file. No source.

The return bus is written as `super_deluxe`. If the owner's ticket is the 45-seater, change both of its trip references in the file to `deluxe`.
