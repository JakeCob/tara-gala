# Hand-entered data

Fill these CSVs from the **operator's own website or Facebook page**, never from aggregators or travel blogs.
Every row needs `verified_on` (the date you checked) so the app can show how fresh it is.
Open them in Google Sheets or Excel, then download as CSV with the same file name.

Load with `python data/load_data.py --dry-run` first, then without `--dry-run`. Re-running updates rows instead of duplicating them.
A line starting with `#` is skipped.

## routes_trips.csv: one row per departure

| Column | Required | Example | Notes |
| --- | --- | --- | --- |
| operator | yes | `victory-liner` | `victory-liner`, `genesis`, `solid-north` |
| origin | yes | `vl-cubao` | terminal slug, see list below |
| destination | yes | `vl-baguio` | terminal slug |
| via | no | `Luisita` | route variant as the operator names it |
| class | yes | `regular_aircon` | `regular_aircon`, `deluxe`, `super_deluxe`, `executive`, `premiere`, `first_class`, `luxury`, `royal_class`, `p2p` |
| fare_php | no | `731` | |
| travel_minutes | no | `360` | typical trip length |
| seat_layout | no | `2x2` | |
| has_restroom | no | `yes` | yes / no |
| departure_time | yes | `9:30 AM` or `09:30` | Manila time |
| days | no | `daily` | `daily` (default), `weekdays`, `weekends`, or `fri,sat,sun` |
| valid_from / valid_to | no | `2026-11-01` | for temporary or holiday schedules |
| source_url | yes | operator page or FB post | where you checked it |
| verified_on | yes | `2026-10-24` | the day you checked |
| notes | no | | |

Each operator + origin + destination + via + class becomes one route; every row adds a departure to it.

## spots.csv

`slug` (e.g. `burnham-park`), `name`, `category` (`park`, `food`, `market`, `museum`, `viewpoint`, `shopping`, `church`, `cafe`, `other`), `lat`, `lng`, `description`, `visit_minutes`, `entrance_fee_php`.

## last_mile_routes.csv: one leg each

Fill exactly one of `from_terminal` / `from_spot`, and exactly one of `to_terminal` / `to_spot`.
`mode` is `jeep`, `taxi`, `walk`, `tricycle`, `van` or `grab`. For jeeps, `signboard` is the text on the jeep and `boarding_point` is where to catch it.
`verified_on` is required.

## premade_itineraries.json

The 2 to 3 hand-made trip plans (TG-24) that stand in for the live AI planner. Author each one by slugs and times, never ids: trips as `operator` + `origin` terminal + `departure` + `date` (add `class`, `via` or `destination` if two trips match), stops by spot slug, and each stop's leg as `from` / `to` slugs + `mode` (plus `signboard` if two legs match). The `_example` in the file shows the shape; keys starting with `_` are ignored.

- `key` (`food-trip`) becomes the share link `premade-food-trip` and stays the same on every reload.
- `party` lists passenger types only (`adult`, `student`, `senior`, `pwd`, `child`). No names: these plans are public.
- Day 1 is the day the bus **arrives** (an overnight bus makes it the next day). Day 1's first leg starts at the arrival terminal; every later leg starts at the previous stop, so day 2 starts wherever day 1 ended (normally the lodging).
- The last stop must leave at least 30 minutes before the return bus.

Load with `python data/load_premade.py --dry-run` first, then without `--dry-run`. Any problem saves nothing. `--prune` deletes pre-made rows that are no longer in the file.

**Re-check after data changes.** After loading trip data or a scraper run, and again before Nov 5, run `python data/load_premade.py --dry-run`. It re-resolves and re-validates every entry against the current database and lists any that broke, for example when the scraper has deactivated a trip. The API hides a plan that no longer validates (and logs a `premade itinerary dropped` warning), which would quietly remove the trip fallback.

## Terminal slugs

| Slug | Terminal |
| --- | --- |
| `vl-cubao`, `vl-pasay`, `vl-caloocan`, `vl-sampaloc` | Victory Liner, Metro Manila |
| `gen-cubao`, `gen-pasay`, `gen-avenida` | Genesis / Joy Bus, Metro Manila |
| `sn-cubao`, `pitx` | Solid North, Metro Manila |
| `vl-baguio`, `gen-baguio`, `sn-baguio` | Baguio terminals |
