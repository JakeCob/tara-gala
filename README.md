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
- `--database-url` still works but warns: it shows the password in `ps`. Prefer `DATABASE_URL` (env or repo `.env`). The daily run below refuses the flag and reads a root-only env file instead.
- If a fetched direction comes back with no trips at all, the whole run aborts with nothing written (both directions) and exits non-zero. If the reverse direction keeps failing, run with `--direction to-baguio` until it's fixed. While runs abort, outbound `last_verified_at` stops advancing.
- The Baguio to Pasay, Caloocan and Sampaloc API codes are assumed to match the outbound ones; only Baguio to Cubao was checked live. The first live `--dry-run` confirms them: a wrong code fails the run, or prints `WARNING: no trips at all for BAGUIO->...`.
- One route per terminal pair + class. Express and Inner Cities share a class, so the route keeps the longest running time and lists each branding's own time in `routes.notes`.
- **One-off trips.** A departure is saved as weekly only for weekdays it was seen on *every* time in the 14-day window. Two exceptions:
  - **Today:** today counts only for departures more than 3 hours after the scrape (`TODAY_MARGIN`), because earlier buses may already have left.
  - **Empty dates:** a date on which a route returned no trips at all is ignored, and printed as `WARNING: no trips at all for <leg> on <date>`.

  Any other date a departure was seen on is saved for that date only (`valid_from = valid_to`), so a holiday extra on Sat Oct 31 never shows up on Sat Nov 7. Each one prints a `one-off:` line, a weekly trip whose weekdays change prints a `weekly:` line, and every trip set inactive prints a `deactivated:` line (after the commit, so a failed run lists nothing). Dated rows not seen again are set inactive like any other scraped trip. Known gaps: an early extra (within 3 hours of the scrape) seen only on the same weekday next week is still saved as weekly; and after a manual run at another hour, the next 4am run is the one that counts. Keep the cron at 4am for that reason.

### Daily run (cron)
The VPS runs the scrape every day at **04:00 Manila**. The VPS clock is UTC and Manila is UTC+8 with no daylight saving, so that is **20:00 UTC** the day before. TG-9's same-day rule assumes a 04:00 run, so don't move it.

Cron runs `scraper/cron.sh`, installed as `/usr/local/sbin/tara-gala-scrape`. Each run it:
- takes a lock, so two runs never overlap;
- reads `DATABASE_URL` from `/root/.config/tara-gala-scraper.env`, which must be mode 600 and owned by root. The file is **parsed, not sourced** (the one intended difference from the ticket): a password with `$`, `'`, `&` or spaces arrives intact, and nothing in the file is executed. The value is never printed, and the wrapper refuses a database URL passed on the command line;
- fetches `main` over https into a private mirror under `/var/lib/tara-gala-scraper` and runs an export of it, never a working checkout, so merged scraper changes (TG-9) are picked up with no edit. If GitHub is down it warns and reruns the previous export;
- keeps its own venv there, reinstalled only when `api/requirements.txt` changes;
- logs `START`, `END rc=…`, and any `FAILED`, `WARNING` or `SKIPPED` line, plus the scraper's own output, to `/var/log/tara-gala-scraper.log`. It warns when the last successful scrape is more than 36 hours old.

**Owner steps** (as root on the VPS, once the Railway database exists; nothing here is installed automatically):

1. Create the env file. The value is the Railway Postgres `DATABASE_PUBLIC_URL` (the public proxy URL, which works from the VPS): Railway dashboard → **jacob-rafal's Projects** workspace → `tara-gala` → `Postgres` → Variables → `DATABASE_PUBLIC_URL`. Never take it from a project in another workspace. From the CLI, `railway variables` with that project, service and environment named explicitly shows the same value; it prints raw secrets, so only ever pipe it, never leave it on screen or in a file. Paste it in the editor, never on the command line, so it stays out of your shell history:
   ```sh
   mkdir -p -m 700 /root/.config
   install -m 600 /dev/null /root/.config/tara-gala-scraper.env
   nano /root/.config/tara-gala-scraper.env      # exactly one line: DATABASE_URL=postgresql://...
   stat -c '%a %U %s bytes' /root/.config/tara-gala-scraper.env   # expect 600 root and a size above 0; don't print the file
   ```
   Write the line with no quotes and no trailing space: the wrapper uses everything after `DATABASE_URL=` as-is (it strips only a Windows line ending), so a quote or a trailing space would end up inside the URL and the run would fail late with `rc=1`.
2. Install the wrapper and the log rotation from `main` (not from whatever branch the checkout is on):
   ```sh
   cd /root/projects/personal/tara-gala && git fetch -q origin main
   git show origin/main:scraper/cron.sh | install -m 755 /dev/stdin /usr/local/sbin/tara-gala-scrape
   git show origin/main:scraper/logrotate.conf | install -m 644 /dev/stdin /etc/logrotate.d/tara-gala-scraper
   ```
   The scraper code updates itself every run, but the wrapper doesn't: after a merged change to `scraper/cron.sh`, run this step again.
3. Try it: a dry run fetches everything (about 5 minutes), builds the venv and writes nothing:
   ```sh
   tara-gala-scrape --dry-run >> /var/log/tara-gala-scraper.log 2>&1; echo rc=$?
   ```
4. Schedule it: run `crontab -e` as root and add these two lines:
   ```cron
   # Tara Gala: Victory Liner scrape at 04:00 Manila = 20:00 UTC (the VPS clock is UTC). TG-9 assumes 04:00; don't move it.
   0 20 * * * /usr/local/sbin/tara-gala-scrape >> /var/log/tara-gala-scraper.log 2>&1
   ```
   Check with `crontab -l | grep tara-gala`. If the VPS time zone ever changes from UTC (`timedatectl`), recompute the hour.

**Reading the log:** `grep -E 'START|END|FAILED|WARNING|SKIPPED' /var/log/tara-gala-scraper.log | tail`. Every run has a `START sha=…` line and an `END rc=…` line; a failed run ends with `FAILED`. Run one by hand any time with `tara-gala-scrape` (or `tara-gala-scrape --dry-run`), but not within 10 minutes of 20:00 UTC.

| Exit | Meaning |
|---|---|
| `0` | ok |
| `1` | the scraper failed (any non-zero exit from the scraper is passed through as-is) |
| `2` | config or venv: env file missing, wrong mode or owner, no `DATABASE_URL`, a database URL passed on the command line, or `pip install` failed |
| `3` | no code: the first fetch from GitHub failed |
| `75` | skipped: another run holds the lock |

- **New database password:** edit the env file again (step 1). A wrong password fails late, after the full 5-minute fetch, with `END rc=1 … FAILED`; that's slow, not hung.
- **Pause:** comment out the line with `crontab -e`.
- **Known limit:** everything runs as root, including the fetch and `pip install` of code from GitHub. That's acceptable on a personal VPS where only the owner pushes to `main`; a dedicated system user is post-trip hardening.

## 5. API
```bash
cd api
uvicorn app.main:app --reload --env-file ../.env   # http://localhost:8000/docs
```

Endpoints: `GET /health`, `GET /terminals`, `GET /trips?origin_city=Metro Manila&destination_city=Baguio&date=2026-11-06`, `GET /spots`, `GET /last-mile?terminal=vl-baguio` (or `?spot=<slug>`), `GET /premade-itineraries` (404 when `PREMADE_ITINERARIES=false`), `GET /itineraries/{share_slug}` (one saved plan by its share link), `POST /plan` (live AI planner; 404 unless `PLANNER_LIVE=true`, see below).

Tests run against a throwaway Postgres: `cd api && TEST_DATABASE_URL=postgresql://... python -m pytest` (use `python -m`: a bare `pytest` can't import `app`). Without `TEST_DATABASE_URL` the run is skipped and exits non-zero.

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

Checks (same as CI):
```bash
npx next typegen && npx tsc --noEmit   # a fresh checkout needs typegen first, or tsc fails on LayoutProps
npm run lint
npm test                               # node:test, Node 22.18+
npm run build
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

Tests: the API flag tests run with the normal pytest command (section 5). The web tests run with `cd web && npm test`, which uses Node's built-in `node --test` and needs Node 22.18 or later for TypeScript type stripping. CI runs them as they are (section 9).

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

## 9. CI
GitHub Actions (`.github/workflows/ci.yml`, workflow `CI`) runs on every pull request and every push to `main`. It has two jobs:
- **web:** Node 24, in `web/`: `npm ci`, `npx next typegen`, `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build`.
- **api:** Python 3.12 with a `postgres:16` service container, in `api/`: `pip install -r requirements.txt`, then `python -m pytest -q -rs` with `TEST_DATABASE_URL` pointed at the container.

npm and pip are cached. A new push to a pull request cancels that PR's older run. Runs on `main` are never cancelled.

CI uses no secrets: the token is read-only, and no `LLM_API_KEY` or `DATABASE_URL` is set. The Postgres password in `ci.yml` belongs to the throwaway service container. CI doesn't deploy either: deploys are manual (`railway up`, section 8).

Reading a failure: the red step's name says which check failed (tsc, lint, `npm test`, build or pytest), and the same command runs locally (sections 5 and 6). For `api` failures, the Postgres service log is in the job's "Stop containers" step. `-rs` prints the reason for any skipped test.

### Branch protection (not switched on yet; owner decision)
It needs one finished CI run first, so the `web` and `api` check names exist. Don't rename the jobs without updating this section. With a repo-admin token:
```bash
gh api -X PUT repos/JakeCob/tara-gala/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": { "strict": false, "contexts": ["web", "api"] },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null
}
JSON
```
- Check: `gh api repos/JakeCob/tara-gala/branches/main/protection --jq '.required_status_checks.contexts, .enforce_admins.enabled'`
- Undo: `gh api -X DELETE repos/JakeCob/tara-gala/branches/main/protection`
- Emergency bypass that keeps the checks: `gh api -X DELETE repos/JakeCob/tara-gala/branches/main/protection/enforce_admins`, merge, then put it back with `gh api -X POST repos/JakeCob/tara-gala/branches/main/protection/enforce_admins`.

Or click through: repo **Settings** → **Branches** → **Add classic branch protection rule**, with branch name pattern `main`. Tick **Require status checks to pass before merging** and add `web` and `api`. Leave **Require branches to be up to date** off. Tick **Do not allow bypassing the above settings**, then click **Create**.

Why these values:
- **`enforce_admins: true`:** every merge here uses an admin token, so without it a red check could be merged anyway.
- **`strict: false`:** PRs are rebased before merge already, so forcing up-to-date branches would only add re-runs.
- **No required reviews:** reviews happen outside GitHub.
- **Rulesets:** if this moves to a ruleset later, the same names go under `required_status_checks[].context`.
