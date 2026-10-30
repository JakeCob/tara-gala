# Release checklist: Nov 5 freeze, Nov 6 trip

The trip is Manila → Baguio on Fri Nov 6, 2026, returning Baguio → Manila on Sun Nov 8. The freeze is Thu Nov 5. Tick each box and add the date and your initials.

Hostnames, project and service IDs, and the deploy scripts are in the ops notes outside the repo (README §8). This file never holds a secret, a `DATABASE_URL` value or a hostname.

## 1. Freeze rules (from Nov 5, 00:00 Manila)
- Bug fixes only (`CLAUDE.md`). No features, no new dependency, no schema change, no new data source.
- A fix is one PR with CI green (`web` and `api`), merged to `main`, then redeployed and checked with §2. Nothing is deployed from a branch or a dirty checkout.
- A flag changes only as a kill switch (§7). Decide the live planner before the freeze (§6).
- Data fixes are allowed when they come from a source: dry-run first, then load, then `python data/load_premade.py --dry-run`.
- Last deploy: **Nov 5, 18:00 Manila** (proposed; the owner can move it). After it, every traveller redoes §4 steps 2 to 6.
- The scraper cron keeps running; it refreshes the "Checked" dates. Never run it by hand within 10 minutes of 20:00 UTC.

## 2. Final deploy and verify
- [ ] CI is green on `main` at the SHA: `gh run list --branch main --limit 1`.
- [ ] Redeploy with the ops notes' "Redeploy" steps:
  - `check_vars.py` is all ok;
  - migrations and loaders run only if `supabase/` or `data/` changed;
  - `railway up` the api, then deploy web to Vercel production (the ops notes have a script);
  - both deployments reach `SUCCESS`.
- [ ] Read the api logs right away, because Railway drops them on the next deploy: `railway logs -s api -p "$P" -e production --lines 200`.
  - There is no `ERROR`.
  - The startup line reads `feature flags: planner_live=False premade_itineraries=True real_map=False`, with `planner_live=True` only if §6 turned it on.
- [ ] Run the live checks. Every line must print its expected value.
  ```sh
  API=https://<api host>; WEB=https://<web host>     # from the ops notes
  curl -fsS "$API/health"; echo                                                  # {"status":"ok"}
  for q in "origin_city=Metro%20Manila&destination_city=Baguio&date=2026-11-06" \
           "origin_city=Baguio&destination_city=Metro%20Manila&date=2026-11-08"; do
    curl -fsS "$API/trips?$q" | python3 -c 'import json,sys; t=json.load(sys.stdin); bad=[x for x in t if not (x["booking_url"] and x["last_verified_at"] and x["confirm_note"])]; print(len(t), "trips,", len(bad), "missing booking/checked/note")'
  done                                                                           # >0 trips, 0 missing, both dates
  curl -fsS "$API/premade-itineraries" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d), [x["share_slug"] for x in d])'   # 3 slugs
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/plan" -H 'content-type: application/json' -d '{}'   # 404 while the planner is off
  for p in / /plan /baguio /manifest.webmanifest /offline.html /i/<each slug>; do
    curl -fsS -o /dev/null -w "%{http_code} $p\n" "$WEB$p"
  done                                                                           # all 200
  curl -fsSI "$WEB/sw.js" | grep -i '^cache-control'                             # no-cache, no-store
  curl -fsS "$WEB/sw.js" | grep -o 'SW_VERSION = "[^"]*"'                        # same as web/public/sw.js at the SHA
  curl -fsS -o /dev/null -D - -H "Origin: $WEB" "$API/premade-itineraries" | grep -i '^access-control-allow-origin'   # the web origin
  ```
- [ ] On a phone (or headless at 380px):
  - the Nov 6 and Nov 8 searches show cards with "Checked <date>" and a Book link;
  - `/plan` lists 3 ready-made trips, and each one opens its map;
  - `/baguio` loads;
  - there's no sideways scroll.
- [ ] Record the SHA, both deployment IDs and the time in the ops notes' "Later deploys" table.

## 3. Rollback
1. **api (Railway):** run `railway deployment list -s api -p "$P" -e production --limit 5 --json`, pick the previous `SUCCESS` ID and check it belongs to this project's service. Then run `railway api 'mutation($id: String!) { deploymentRollback(id: $id) }' --var id=<deployment-id>`. Or `railway up` the previous SHA's export.
2. **web (Vercel):** `vercel rollback` (or `vercel promote <previous deployment URL>`), with the personal account's config. Or deploy the previous SHA's `web/` again.
3. Rerun the §2 live checks.
4. Revert the bad PR on `main` too, so the next deploy doesn't bring it back.

Notes:
- `railway redeploy` is not a rollback: it rebuilds the latest deployment.
- **A bad variable:** set it back. A `NEXT_PUBLIC_*` change on Vercel also needs a web redeploy.
- **Bad data:** fix the input and rerun the loader or the scraper. Both are idempotent.
- **Rolling back web changes `sw.js`:** phones show "A new version of Tara Gala is ready." Each traveller taps Reload while online.

## 4. Phone readiness (each traveller, after the last deploy)
| Traveller | Phone | Steps 1 to 6 done (date) |
|---|---|---|
| | | |

1. **Install.** Android: Chrome menu ⋮ → Install app. iPhone: Safari → Share → Add to Home Screen. From now on, open it from the home-screen icon.
2. **Update.** Open the app online. If "A new version of Tara Gala is ready." shows, tap **Reload**, or close and reopen the app.
3. **Buses and Baguio.** Search Nov 6 Manila → Baguio and Nov 8 Baguio → Manila once each, then open the Baguio page.
4. **Trips.** Open `/plan` (Plan a Baguio trip) and load the ready-made list. Open every trip you might use once, and your own trip link (`/i/<slug>`) once. A trip's page is saved only after you've opened it.
   - After the last deploy, open the home page and each saved trip's map online once, so the decor pictures (TG-45) and the passengers' looks (TG-48) are saved too.
5. **Offline test.** Turn on airplane mode and open the app from the icon. The yellow saved banner shows, along with both searches, the Baguio page and the trip pages. Turn airplane mode off.
6. **Backup.** Take screenshots of the bus cards for both dates and of your trip page.
- **iPhone:** open the app at least once in the days before the trip. Safari can clear a site's saved data after about a week without use.

## 5. Data checks (by Nov 4)
- [ ] **TG-28, recheck trips.** For Nov 6 (Manila → Baguio) and Nov 8 (Baguio → Manila):
  - compare every trip the app shows from the boarding terminal with the operator's own booking page;
  - "Checked" is under 36 hours old;
  - report any mismatch, and never type a time without an operator `source_url`.
- [ ] **Verify or rewrite the agent-researched notes.** The rows noted `agent-researched (tg-data), owner to verify` are:
  - the 14 spots in `data/spots.csv`, Finteo included;
  - 43 legs in `data/last_mile_routes.csv`;
  - the 12 terminals in `supabase/data/terminals_coords.sql`;
  - the 155 generated taxi legs (note "manager-approved generated leg … owner to verify").

  Check each one against its source in `data/SOURCES.md`. Then remove "owner to verify" from the note, or fix or delete the row, and reload (dry-run first). Until then, the note shows on the leg cards people see. Do these first: the boarding terminal, `vl-baguio`, the legs to and from Finteo, and the legs on the trips you'll use.
- [ ] **TG-7, terminal tap test.** Confirm the lat/lng of the Nov 6 boarding terminal and `vl-baguio`. Then, on a real phone:
  - tap the terminal's Google Maps link on a Nov 6 bus card: Maps opens at the right building with transit directions;
  - repeat for the Baguio terminal on a Nov 8 card.
- [ ] After any data load or scraper run, `python data/load_premade.py --dry-run` passes, and so do the §2 checks for the ready-made trips.

## 6. Owner-only actions
- [ ] **Scraper cron (TG-8).** Follow README §4 "Owner steps" 1 to 4.
  - `crontab -l | grep tara-gala` shows the `0 20 * * *` line.
  - The next morning, `grep -E 'START|END' /var/log/tara-gala-scraper.log | tail -2` shows `END rc=0`.
- [ ] **Branch protection.** Run the README §9 `gh api` command with a repo-admin token, then the check command printed there.
- [ ] **Genesis and Solid North (TG-5, TG-6).** No official source was found (`DATA-schedules` findings). Choose one:
  - read their Facebook pages while logged in, and enter times in `data/routes_trips.csv` with the post as `source_url`;
  - allow iWantSeats as a source for Genesis;
  - go Victory Liner only, and check the other two at the counter.
- [ ] **Finteo listing (TG-34).** Check the booking: is it "Finteo Skylands Premium, 96 Doctor Carino Street", the loaded spot, or "Finteo Skylands, 99 Dr. Cariño", the OSM listing about 42 m away? Fix the spot's address or lat/lng if needed, and rewrite its note.
- [ ] **LLM key decision (TG-25), before the freeze.**
  - **Off (current):** nothing to do. `/plan` shows the ready-made list.
  - **On:**
    - a key the owner chooses for production, set only on the Railway `api` service (`LLM_PROVIDER`, `LLM_API_KEY`);
    - a monthly spend limit at the provider;
    - `PLANNER_LIVE=true` on api (Railway) and `NEXT_PUBLIC_PLANNER_LIVE=true` on web (Vercel), then a web redeploy;
    - TG-25's end-to-end run.
- [ ] **Railway spend.** `railway usage --workspace <id>` is well under the workspace's hard limit. Hitting it stops the services.

## 7. Trip-day fallback
- **A bus time in doubt:** the operator's counter or page wins. Every card says to confirm with the operator. Use the §4 screenshots.
- **The api or web is down:** installed phones keep their saved pages offline, under the yellow banner. Roll back (§3).
- **Kill switches.** Each one is a host variable (api on Railway, web on Vercel): set it to `false`, apply as shown, then rerun §2. To undo, set it back to `true` the same way.

| Symptom | Switch | Applies when | What changes |
|---|---|---|---|
| The map misbehaves on a phone | `NEXT_PUBLIC_OVERWORLD_MAP` (web) | after a web redeploy on Vercel | `/i/<slug>` shows the list view, with the same facts. Phones pick it up on their next online load. |
| A ready-made trip is wrong | `PREMADE_ITINERARIES` (api) and `NEXT_PUBLIC_PREMADE_ITINERARIES` (web) | api: Railway restarts it on the change; web: after a redeploy on Vercel | `/plan` stops listing them. Share links `/i/<slug>` still open. A phone that saved the list can still show it offline. Fixing the data is usually better. |
| The service worker serves broken pages | `NEXT_PUBLIC_SERVICE_WORKER` (web) | after a web redeploy on Vercel | **Last resort.** On its next online load, each phone unregisters the worker and **deletes every saved page, trips and itineraries included**, so offline use ends. Warn the travellers first. Undoing it means every traveller redoes §4 steps 2 to 5 online. |
