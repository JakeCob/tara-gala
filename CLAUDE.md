# Tara Gala

Door-to-door trip planner for Philippine provincial bus travel. The MVP covers **Manila to Baguio only**.
Hard deadline: working PWA by **2026-11-05**, used for a real trip on **2026-11-06**.

## What it does
1. **Complete bus schedules**: every Manila to Baguio trip from Victory Liner, Genesis/Joy Bus and Solid North, with a link to wherever each trip can be booked. Aggregators like BusTickets.ph only show part of the inventory, so this is the core value.
2. **Baguio last mile**: hand-curated jeep, taxi and walking routes from the bus terminals to the top spots.
3. **Grounded AI itinerary planner**: input date, party, budget, vibe; output bus picks plus day-by-day stops, built only from rows in the database.
4. **Game-style UI**: a chibi character spawns for each passenger (adult, student, senior, PWD), and the itinerary renders as a Mario-style overworld map, with a toggle to a real map for directions.

Metro Manila first mile (home to terminal) is NOT built: deep-link to Sakay.ph or Google Maps.

## Stack
- `web/`: Next.js (App Router) + Tailwind, installable PWA, mobile-first (~380px viewport)
- `api/`: Python FastAPI, deployed on Railway
- `supabase/schema.sql`: PostgreSQL schema (already written, see below)
- `scraper/`: one Victory Liner schedule scraper (timeboxed to one evening; fall back to hand entry)

## Database
Schema lives in `supabase/schema.sql`. Do not change table shapes without asking.
- `operators`, `terminals`, `operator_terminals`: seeded (3 operators, 12 terminals)
- `routes`: one origin + destination + route variant (`via`: Gerona, Urdaneta, Luisita, TPLEX) + `class`
- `trips`: each departure; carries `source`, `source_url`, `last_verified_at`
- `trip_reports`: admin checks now, crowd reports later
- `spots`, `last_mile_routes`: Baguio places and legs (exactly one origin and one destination per leg)
- `itineraries`: saved planner output with a random `share_slug`
- `trip_search` view: flattened active trips for the API (security_invoker, respects RLS)
RLS: public read on reference tables; all writes go through the API with the service role key.

## Non-negotiable rules
- **Never invent schedule data.** Every bus time shown must come from `trips`. The planner's JSON output is validated in FastAPI: every bus leg must reference an existing `trip_id`, every stop a `spot_id`, every leg a `last_mile_route_id`. Reject and retry otherwise.
- Show `last_verified_at` on every trip, plus a "confirm with operator" note.
- Fares in PHP. Times are local Manila time (Asia/Manila).
- Secrets (Supabase service key, LLM key) only in environment variables, never committed.
- Mobile first. Chibi spawn animation under 0.5s and skippable.

## Planner output shape
```json
{
  "outbound": {"trip_id": "<uuid>", "date": "2026-11-06"},
  "return":   {"trip_id": "<uuid>", "date": "2026-11-08"},
  "days": [
    {"day": 1, "stops": [
      {"spot_id": "<uuid>", "arrive": "13:00", "leave": "15:00",
       "leg": {"last_mile_route_id": "<uuid>"}}
    ]}
  ]
}
```

## Build schedule
1. Oct 24 to 25, data: run schema, hand-enter trips for all 3 operators, one evening on the Victory Liner scraper
2. Oct 26 to 30, core screens: FastAPI trip search on Railway, Next.js PWA shell, schedule search with booking links, chibi passenger picker, 10 to 15 Baguio last-mile routes, Sakay/Google Maps deep link
3. Oct 31 to Nov 1, AI planner + overworld map (Undas weekend: expect half the hours)
4. Nov 2 to 4, finish: real-map toggle, PWA install + offline saved itinerary, recheck every trip, test with 2 to 3 people
5. Nov 5, freeze: bug fixes only

If behind, cut in this order: real-map toggle, live AI planner (use 2 to 3 pre-made itineraries), scraper, AI-generated chibis (keep the asset pack).

## Out of scope until after the trip
Crowd reports UI, province badges, saved party presets, seat picking, more scrapers, other destinations, user accounts.

## Working style
- Small, reviewable steps; run the app or tests after each change.
- Ask before adding a dependency that isn't obviously needed.
- Prefer boring, well-known libraries. The deadline matters more than elegance.
