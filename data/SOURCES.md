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
