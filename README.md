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
3. Copy `.env.example` to `.env` and set `DATABASE_URL` (Project Settings > Database > Connection string, session pooler URI).

## 2. Enter schedule data
Fill the CSVs in `data/` from each operator's own site or Facebook page (see `data/README.md`), then:

```bash
pip install -r api/requirements.txt
python data/load_data.py --dry-run   # validate only
python data/load_data.py             # load into Supabase
```

Re-running is safe: rows are matched and updated, not duplicated.

## 3. API
```bash
cd api
pip install -r requirements.txt
uvicorn app.main:app --reload        # http://localhost:8000/docs
```

Endpoints: `GET /health`, `GET /terminals`, `GET /trips?origin_city=Metro Manila&destination_city=Baguio&date=2026-11-06`.

Tests run against a throwaway Postgres: `TEST_DATABASE_URL=postgresql://... pytest` (tests are skipped without it).

Railway: set the service root to `api/`, add `DATABASE_URL` and `ALLOWED_ORIGINS`; the start command is in `api/Procfile`.

## 4. Web
```bash
cd web
cp .env.example .env.local           # set NEXT_PUBLIC_API_URL
npm install
npm run dev                          # http://localhost:3000
```
