#!/bin/sh
# Daily Victory Liner scrape (TG-8). Installed as /usr/local/sbin/tara-gala-scrape and run from root's crontab at
# 20:00 UTC = 04:00 Manila. Runs main from a private mirror, never from a working checkout. See README section 4.
#
# The DSN comes only from a root-only env file (mode 600, one line DATABASE_URL=...). The file is parsed, never
# sourced, so a password with $ ' & or spaces arrives intact, and the value is never printed.
#
# Exit codes: 0 ok, 1 (or any other) the scraper's own failure, 2 config or venv, 3 no code, 75 already running.
set -u
umask 077

ENV_FILE=${TG_SCRAPER_ENV:-/root/.config/tara-gala-scraper.env}
STATE=${TG_SCRAPER_STATE:-/var/lib/tara-gala-scraper}
GIT_URL=${TG_SCRAPER_GIT_URL:-https://github.com/JakeCob/tara-gala.git}
REF=${TG_SCRAPER_GIT_REF:-main}
LOCK=${TG_SCRAPER_LOCK:-/run/lock/tara-gala-scraper.lock}
STALE_HOURS=36

log() { printf '%s tara-gala-scrape %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { code=$1; shift; log "FAILED $*"; exit "$code"; }

# 1. One run at a time
exec 9>"$LOCK"
flock -n 9 || { log "SKIPPED another run is in progress"; exit 75; }

# 2. Never take the DSN on the command line: it would land in ps and in this log (args are logged at START)
dry_run=no
for arg in "$@"; do
    case $arg in
        --database-url|--database-url=*) fail 2 "config: --database-url is not allowed; use the env file" ;;
        --dry-run) dry_run=yes ;;
    esac
done

# 3. The env file: root-only, parsed for its first DATABASE_URL= line
[ -f "$ENV_FILE" ] || fail 2 "config: $ENV_FILE not found"
perms=$(stat -c '%a %u' "$ENV_FILE")
[ "$perms" = "600 $(id -u)" ] || fail 2 "config: $ENV_FILE must be mode 600 and owned by uid $(id -u) (it is mode ${perms% *}, uid ${perms#* })"
DSN=$(sed -n 's/^DATABASE_URL=//p' "$ENV_FILE" | head -n 1)
CR=$(printf '\r')
DSN=${DSN%"$CR"}
[ -n "$DSN" ] || fail 2 "config: no DATABASE_URL in $ENV_FILE"
DATABASE_URL=$DSN
export DATABASE_URL
unset DSN

# 4. Code: fetch main into a bare mirror and export it; on a fetch or export failure, keep the previous export
mkdir -p "$STATE" || fail 2 "config: cannot create $STATE"
MIRROR=$STATE/repo.git
CODE=$STATE/code
had_code=no
[ -d "$CODE" ] && had_code=yes
[ -d "$MIRROR" ] || git init -q --bare "$MIRROR" >/dev/null 2>&1
rm -rf "$STATE/code.new" "$STATE/code.tar"
if git -C "$MIRROR" fetch -q "$GIT_URL" "+refs/heads/$REF:refs/heads/$REF" >/dev/null 2>&1 &&
    git -C "$MIRROR" archive -o "$STATE/code.tar" "refs/heads/$REF" >/dev/null 2>&1 &&
    mkdir "$STATE/code.new" &&
    tar -xf "$STATE/code.tar" -C "$STATE/code.new" &&
    git -C "$MIRROR" rev-parse --short=12 "refs/heads/$REF" > "$STATE/code.new/.sha"; then
    rm -rf "$STATE/code.old"
    [ -d "$CODE" ] && mv "$CODE" "$STATE/code.old"
    mv "$STATE/code.new" "$CODE"
else
    rm -rf "$STATE/code.new"
    [ -d "$CODE" ] || fail 3 "no code"
    log "WARNING code update failed; using sha=$(cat "$CODE/.sha" 2>/dev/null || echo unknown)"
fi
rm -f "$STATE/code.tar"
SHA=$(cat "$CODE/.sha" 2>/dev/null || echo unknown)

# 5. Python: a private venv, reinstalled only when api/requirements.txt changes (TG_SCRAPER_PYTHON skips this, for tests)
if [ -n "${TG_SCRAPER_PYTHON:-}" ]; then
    PY=$TG_SCRAPER_PYTHON
else
    VENV=$STATE/venv
    [ -x "$VENV/bin/python" ] || python3.12 -m venv "$VENV" >/dev/null 2>&1 || fail 2 "venv: could not create $VENV"
    want=$(sha256sum "$CODE/api/requirements.txt" | cut -d ' ' -f 1)
    have=$(cat "$VENV/.requirements.sha256" 2>/dev/null || true)
    if [ "$want" != "$have" ]; then
        (cd "$CODE" && "$VENV/bin/pip" install -q -r api/requirements.txt) || fail 2 "venv: pip install failed"
        printf '%s\n' "$want" > "$VENV/.requirements.sha256"
    fi
    PY=$VENV/bin/python
fi

# 6. Staleness: the database goes idle if runs keep failing
if [ -f "$STATE/last-success" ]; then
    hours=$(( ($(date +%s) - $(stat -c %Y "$STATE/last-success")) / 3600 ))
    [ "$hours" -gt "$STALE_HOURS" ] && log "WARNING last successful scrape was $hours h ago"
elif [ "$had_code" = yes ]; then
    log "WARNING no successful scrape recorded yet"
fi

# 7. Run the scraper from the export; its own output goes to the same log
start=$(date +%s)
log "START sha=$SHA args=$*"
cd "$CODE" || fail 3 "no code"
"$PY" scraper/victory_liner.py "$@"
rc=$?
duration=$(( $(date +%s) - start ))
if [ "$rc" -eq 0 ]; then
    log "END rc=0 duration_s=$duration"
    [ "$dry_run" = yes ] || touch "$STATE/last-success"
else
    log "END rc=$rc duration_s=$duration FAILED"
fi
exit "$rc"
