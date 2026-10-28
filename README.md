# Tara Gala

Door-to-door trip planner for Philippine provincial bus travel. MVP: Manila to Baguio.
See `CLAUDE.md` for scope, rules and the build schedule.

## Layout

| Folder | What |
| --- | --- |
| `supabase/schema.sql` | Database schema + seed operators/terminals. Run once in the Supabase SQL editor. |
| `api/` | FastAPI backend (deployed on Railway) |
| `data/` | CSV templates you fill by hand + `load_data.py` to load them into Supabase |
| `web/` | Next.js + Tailwind PWA |
| `scraper/` | Victory Liner scraper (block 1, timeboxed) |

## 1. Database
1. Create a Supabase project.
2. SQL editor: paste `supabase/schema.sql`, run once.
3. Copy `.env.example` to `.env` and set `DATABASE_URL` to the full session pooler URI (Connect button in Supabase). Write the password straight into the URI, not as `${VAR}`, and URL-encode special characters in it (`@` is `%40`, `#` is `%23`, `/` is `%2F`).

## 2. Python setup (once)
From the repo root. On Ubuntu/Debian, install `python3-venv` first if `venv` complains.

```bash
python3 -m venv .venv
source .venv/bin/activate            # run this in every new terminal
pip install -r api/requirements.txt
```

## 3. Enter schedule data
Fill the CSVs in `data/` from each operator's own site or Facebook page (see `data/README.md`), then:

```bash
python data/load_data.py --dry-run   # validate only
python data/load_data.py             # load into Supabase
```

Re-running is safe: rows are matched and updated, not duplicated.

## 4. Victory Liner scraper
Pulls the next 14 days of Victory Liner trips in both directions (Cubao, Pasay, Caloocan, Sampaloc to Baguio, and Baguio back to each) from their public booking API: 112 requests, one at a time, 2 seconds apart, so a run takes about 4 to 5 minutes. That's kept on purpose: it's an unattended 4am cron job, and 2s is the polite rate for a public API.

```bash
python scraper/victory_liner.py --dry-run                 # fetch, show what would change, roll back
python scraper/victory_liner.py                           # upsert
python scraper/victory_liner.py --direction to-baguio     # one direction only: to-baguio or from-baguio (56 requests)
```

- Rows are saved with `source = 'scraped'`. Trips that stop appearing are set inactive (`is_active = false`), but only in the direction(s) the run fetched. A `--direction to-baguio` run never deactivates Baguio to Manila trips, and vice versa. Trips with `source = 'manual'` are never touched, and a scraped time that clashes with a manual trip on the same route is skipped.
- Any failed request, unknown bus type or unexpected response shape writes nothing and exits non-zero.
- If a fetched direction comes back with no trips at all, the whole run aborts with nothing written (both directions) and exits non-zero. If the reverse direction keeps failing, run with `--direction to-baguio` until it's fixed. While runs abort, outbound `last_verified_at` stops advancing.
- The Baguio to Pasay, Caloocan and Sampaloc API codes are assumed to match the outbound ones; only Baguio to Cubao was checked live. The first live `--dry-run` confirms them: a wrong code fails the run, or prints `WARNING: no trips at all for BAGUIO->...`.
- One route per terminal pair + class. Express and Inner Cities share a class, so the route keeps the longest running time and lists each branding's own time in `routes.notes`.
- Daily at 4am Manila time (VPS clock in UTC, so 20:00 UTC the day before):

```cron
0 20 * * * cd /root/personal-projects/tara-gala && .venv/bin/python scraper/victory_liner.py >> /var/log/tara-gala-scraper.log 2>&1
```

  If the VPS clock is already Manila time, use `0 4 * * *` instead. Cron mails or logs the non-zero exit when a run fails.

## 5. API
```bash
cd api
uvicorn app.main:app --reload --env-file ../.env   # http://localhost:8000/docs
```

Endpoints: `GET /health`, `GET /terminals`, `GET /trips?origin_city=Metro Manila&destination_city=Baguio&date=2026-11-06`.

Tests run against a throwaway Postgres: `TEST_DATABASE_URL=postgresql://... pytest` (tests are skipped without it).

Railway: set the service root to `api/`, add `DATABASE_URL` and `ALLOWED_ORIGINS`; the start command is in `api/Procfile`.

## 6. Web
```bash
cd web
cp .env.example .env.local           # set NEXT_PUBLIC_API_URL
npm install
npm run dev                          # http://localhost:3000
```
