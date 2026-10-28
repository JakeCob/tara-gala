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

   **Migrations.** A fresh project needs only `schema.sql`. An existing database (one that already ran `schema.sql`) also needs each file in `supabase/migrations/` that it hasn't had yet, pasted into the SQL editor in filename order (`YYYY-MM-DD_tgNN_name.sql`). Each one is safe to re-run. When you change the schema, update `schema.sql` *and* add a migration.
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

`--database-url` still works but warns: it shows the password in `ps`. Prefer `DATABASE_URL` (env or repo `.env`).

Pre-made itineraries (the planner fallback) load the same way from `data/premade_itineraries.json`: `python data/load_premade.py --dry-run`, then without `--dry-run`. See `data/README.md`.

## 4. Victory Liner scraper
Pulls the next 14 days of Victory Liner trips in both directions (Cubao, Pasay, Caloocan, Sampaloc to Baguio, and Baguio back to each) from their public booking API: 112 requests, one at a time, 2 seconds apart, so a run takes about 4 to 5 minutes. That's kept on purpose: it's an unattended 4am cron job, and 2s is the polite rate for a public API.

```bash
python scraper/victory_liner.py --dry-run                 # fetch, show what would change, roll back
python scraper/victory_liner.py                           # upsert
python scraper/victory_liner.py --direction to-baguio     # one direction only: to-baguio or from-baguio (56 requests)
```

- Rows are saved with `source = 'scraped'`. Trips that stop appearing are set inactive (`is_active = false`), but only in the direction(s) the run fetched. A `--direction to-baguio` run never deactivates Baguio to Manila trips, and vice versa. Trips with `source = 'manual'` are never touched, and a scraped time that clashes with a manual trip on the same route is skipped.
- Any failed request, unknown bus type or unexpected response shape writes nothing and exits non-zero.
- A missing operator or terminal seed fails the run with nothing written. Run the `supabase/schema.sql` seeds.
- `--database-url` still works but warns: it shows the password in `ps`. Prefer `DATABASE_URL` (env or repo `.env`).
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

Endpoints: `GET /health`, `GET /terminals`, `GET /trips?origin_city=Metro Manila&destination_city=Baguio&date=2026-11-06`, `GET /spots`, `GET /last-mile?terminal=vl-baguio` (or `?spot=<slug>`), `GET /premade-itineraries` (404 when `PREMADE_ITINERARIES=false`), `POST /plan` (live AI planner; 404 unless `PLANNER_LIVE=true`, see below).

Tests run against a throwaway Postgres: `TEST_DATABASE_URL=postgresql://... pytest` (tests are skipped without it).

Deployed on Railway: see section 8. `api/Procfile` is the start command for local runs and other hosts; on Railway, `api/railway.json` overrides it.

### Live planner (`POST /plan`)
- The body is `{"date", "return_date", "party": [{"type", "name"?}], "budget_php"?, "vibe"}`.
- It returns `201 {"share_slug", "model", "attempts", "plan"}`, where `plan` is the CLAUDE.md planner shape, saved to `itineraries`.
- The model sees only DB rows for the dates. Passenger names are stored with the plan but never sent to the model. Every answer is checked by the plan validator (TG-24), and an invalid one is retried with the errors fed back.
- Input limits (422, no model call):
  - `vibe` is 1 to 60 letters, digits, spaces and `, . ' & ! ? -`
  - 1 to 10 passengers
  - `budget_php` is 500 to 200000
  - `date` is from today (Manila) to a year ahead
  - `return_date` is up to 6 days after `date`
- Errors are `{"detail": {"code", "message"}}`:
  - `rate_limited` 429, with `Retry-After` and `retry_after_s`
  - `no_data` 422
  - `no_valid_plan` and `refused` 502
  - `llm_unavailable`, `daily_cap` and `not_configured` 503
  - `deadline` 504
- Railway env:

| Var | Default | Notes |
|---|---|---|
| `PLANNER_LIVE` | `false` | Feature flag (section 7); off gives 404 |
| `LLM_PROVIDER` | `anthropic` | `anthropic` or `openrouter` |
| `LLM_API_KEY` | (empty) | Required when the planner is on; Railway only, never committed |
| `LLM_MODEL` / `LLM_FALLBACK_MODEL` | `claude-haiku-5-5` / `claude-sonnet-5-5` (OpenRouter: `anthropic/claude-haiku-5.5` / `anthropic/claude-sonnet-5.5`) | Empty fallback means no fallback on a refusal |
| `LLM_EFFORT` | `low` | `low`, `medium`, `high`, `xhigh`, `max` |
| `LLM_MAX_TOKENS` | `8000` | Includes thinking; capped at 16000; doubled once per cut-off reply |
| `LLM_TIMEOUT_SECONDS` | `40` | Per model call |
| `PLANNER_MAX_ATTEMPTS` | `3` | Model calls per request, refusals included |
| `PLANNER_DEADLINE_SECONDS` | `100` | Whole request |
| `PLANNER_DAILY_SPEND_CAP_USD` | `1.00` | Estimated from token counts; resets at Manila midnight |
| `PLANNER_RATE_LIMIT_PER_HOUR` | `10` | Per client IP |

- A bad number falls back to its default with a warning. That warning names the variable, never the value.
- **Limits are in memory.** The rate limit and spend cap reset on every restart or redeploy, and would be per-instance with more than one instance.
  - The cap is checked before each model call, so it can overshoot by up to one call per request in flight.
  - Keep a monthly spend limit at the provider as the backstop.
- **Client IP.** It's the last `X-Forwarded-For` entry (the one Railway's edge writes), else the peer address. Logs show only an 8-character hash of it, salted per process so it can't be reversed.

### Logging
- Everything goes to stdout as `<time> <LEVEL> <logger> <message>`. Timestamps are the server clock, which is UTC on Railway.
- `LOG_LEVEL` is `DEBUG`, `INFO` (default), `WARNING`, `ERROR` or `CRITICAL`, in any case. A bad value logs a warning and uses INFO.
- One `request method=... path=... status=... duration_ms=...` line per request (no query string, headers or body). Uvicorn's own access log is turned off on purpose, so there is one line, not two.
- An unhandled error logs a stack trace at ERROR and returns a generic `500 {"detail": "Internal server error"}`.
- Secrets are masked as `***`: the `DATABASE_URL` value and its password, values of `*KEY*`, `*SECRET*`, `*TOKEN*` and `*PASSWORD*` vars (8+ characters), and any `scheme://user:password@` or `password=` text.

## 6. Web
```bash
cd web
cp .env.example .env.local           # set NEXT_PUBLIC_API_URL
npm install
npm run dev                          # http://localhost:3000
```

### Offline and install (TG-27)
The service worker (`web/public/sw.js`, hand-written) registers only in a production build (`npm run build && npm start`), never under `next dev`. It keeps the app shell, trip searches and last-mile routes on the phone, and shows a yellow banner with the saved time when it serves them from there. Bump `SW_VERSION` in `sw.js` on every change to it; open tabs then show "A new version of Tara Gala is ready." with a Reload button.

Installing, for testers:
- Android: Chrome menu ⋮ → Install app (or Add to Home screen).
- iPhone: Safari → Share → Add to Home Screen. On iPhone, install it and open your saved itinerary at least once before the trip. Safari may clear a site's saved data after about a week without use, and the installed app is the reliable way to keep it.
- Open the app once online (search your dates, open the Baguio page) before going somewhere without signal.

## 7. Feature flags
Each flag is an environment variable on both sides: the API reads it from `os.environ` (`api/app/flags.py`), the web app from a `NEXT_PUBLIC_` variable (`web/src/lib/flags.ts`).

| Flag | API (Railway `api` service) | Web (Railway `web` service) | Default | Turns on |
|---|---|---|---|---|
| Live AI planner | `PLANNER_LIVE` | `NEXT_PUBLIC_PLANNER_LIVE` | `false` | TG-25 live planner |
| Pre-made itineraries | `PREMADE_ITINERARIES` | `NEXT_PUBLIC_PREMADE_ITINERARIES` | `true` | TG-24 pre-made itineraries |
| Real-map toggle | `REAL_MAP` | `NEXT_PUBLIC_REAL_MAP` | `false` | TG-26 real map (cut) |
| Offline service worker | - | `NEXT_PUBLIC_SERVICE_WORKER` | `true` | TG-27 offline caching. Web only. Setting `false` is the kill switch: on the next online load each phone unregisters the worker and deletes its `tg-*` caches, **saved trips and itineraries included** |

Values are trimmed and case-insensitive. `1`, `true`, `yes`, `on` mean on; `0`, `false`, `no`, `off` mean off. Unset or empty uses the default. Anything else also uses the default: the API logs a warning naming the variable, the web app falls back silently.

- Set both sides together (e.g. `PLANNER_LIVE` on the Railway `api` service and `NEXT_PUBLIC_PLANNER_LIVE` on the Railway `web` service). The API value decides server behaviour; the web value decides what the UI shows.
- The API reads flags once per process and logs them at startup, so changing a flag on Railway takes effect when the API restarts (Railway redeploys on a variable change).
- Web flags are baked in at `next build`: change the `web` service variable on Railway, then rebuild web with `railway up` (section 8). A restart or `railway redeploy` reuses the old build and keeps the old value.

Tests: the API flag tests run with the normal pytest command (section 5). The web tests run with `cd web && npm test`, which uses Node's built-in `node --test` and needs Node 22.18 or later for TypeScript type stripping. They use `node:test`, not Vitest, so TG-18 must port `web/src/lib/flags.test.ts` to Vitest or exclude it.

## 8. Deploy (Railway)
One Railway project with three services in its `production` environment: `Postgres` (Railway's Postgres), `api` (FastAPI) and `web` (`next start`). Both app services get a generated `*.up.railway.app` domain on port 8080.

- Build config lives in the repo: `api/railway.json` and `web/railway.json` (Railpack builder, start command bound to `0.0.0.0:8080`, health checks on `/health` and `/`), plus `api/.python-version` (3.12) and `web/.node-version` (24). `/health` runs `select 1`, so a deploy that can't reach the database fails its health check and the previous deployment keeps serving.
- Variables are set only on Railway, never in the repo:
  - `api`: `DATABASE_URL` (the reference `${{Postgres.DATABASE_URL}}`, the private network), `PORT`, `ALLOWED_ORIGINS` (the web origin), `LOG_LEVEL`, `PLANNER_LIVE`, `PREMADE_ITINERARIES`, `REAL_MAP`, `RAILPACK_DEPLOY_APT_PACKAGES` (`tzdata`, for `Asia/Manila`).
  - `web`: `PORT`, `NEXT_PUBLIC_API_URL` (the api origin), `NEXT_PUBLIC_PLANNER_LIVE`, `NEXT_PUBLIC_PREMADE_ITINERARIES`, `NEXT_PUBLIC_REAL_MAP`, `NEXT_PUBLIC_SERVICE_WORKER`, `NEXT_TELEMETRY_DISABLED`. `NEXT_PUBLIC_*` values are inlined at build time, so set them before the first web deploy and rebuild after a change.
  - No LLM key and no Supabase variables.
- `DATABASE_PUBLIC_URL` (Postgres' TCP proxy) is used only from the VPS, for the schema, the migrations and the scraper and loader runs (sections 1, 3 and 4). It is never set on `api`.
- Redeploy after a merge to `main`: export a clean copy of `main` (`git archive`), apply `supabase/schema.sql` if new and every file in `supabase/migrations/` (safe to re-run), run the loaders if `data/` changed, then `railway up <export>/api --path-as-root` and `railway up <export>/web --path-as-root`, then the smoke test (`/health`, `/terminals`, `/trips` for both directions, CORS from the web origin, the pages at 380px).
- Project and service IDs, hostnames, the exact commands and the rollback steps are in the ops notes, which live outside the repo.
