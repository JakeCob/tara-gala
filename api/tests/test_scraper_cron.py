"""TG-8: the daily scrape wrapper (scraper/cron.sh), its logrotate rule and the README cron section.

No network and no DB: the code source is a throwaway local git repo, and "python" is a fake that records what it
was given. The DSN below is a made-up marker; it must never appear in the wrapper's output or state files.
"""

import fcntl
import os
import re
import stat
import subprocess
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

ROOT = Path(__file__).resolve().parents[2]
CRON_SH = ROOT / "scraper" / "cron.sh"
LOGROTATE = ROOT / "scraper" / "logrotate.conf"
README = ROOT / "README.md"

MARK = "TG8MARK"
DSN = f"postgresql://u:{MARK}'p$a&s\"s w#rd@h:1/d"
PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
LINE_RE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ tara-gala-scrape (START|END|FAILED|WARNING|SKIPPED)\b")
CRON_LINE = "0 20 * * * /usr/local/sbin/tara-gala-scrape >> /var/log/tara-gala-scraper.log 2>&1"

FAKE_PY = """#!/bin/sh
# Fake python for TG-8 tests: records what the wrapper gave it, prints nothing, exits with $FAKE_RC.
d="$FAKE_DIR"
mkdir -p "$d"
printf '%s\\0' "$@" > "$d/argv"
pwd > "$d/cwd"
(umask 077; printf '%s' "$DATABASE_URL" > "$d/dsn")
ls -A > "$d/ls"
cat scraper/victory_liner.py > "$d/script" 2>/dev/null
exit "${FAKE_RC:-0}"
"""


def git_env(home: Path) -> dict:
    # Isolated from this machine's git config, like a fresh CI runner (review finding 1)
    return {
        "PATH": PATH, "HOME": str(home), "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_AUTHOR_NAME": "tg-test", "GIT_AUTHOR_EMAIL": "tg-test@example.invalid",
        "GIT_COMMITTER_NAME": "tg-test", "GIT_COMMITTER_EMAIL": "tg-test@example.invalid",
    }


@dataclass
class H:
    tmp: Path
    src: Path
    state: Path
    env_file: Path
    lock: Path
    fake: Path
    fake_dir: Path
    cwd: Path

    def git(self, *args: str) -> str:
        return subprocess.run(["git", "-C", str(self.src), *args], env=git_env(self.tmp), check=True,
                              capture_output=True, text=True).stdout.strip()

    def commit(self, script_body: str, requirements: str = "psycopg==3.2.*\n") -> str:
        (self.src / "scraper").mkdir(exist_ok=True)
        (self.src / "api").mkdir(exist_ok=True)
        (self.src / "scraper" / "victory_liner.py").write_text(script_body)
        (self.src / "api" / "requirements.txt").write_text(requirements)
        self.git("add", "scraper", "api")
        self.git("commit", "-q", "-m", "stub")
        return self.git("rev-parse", "--short=12", "main")

    def write_env(self, content: str | bytes, mode: int = 0o600) -> None:
        data = content.encode() if isinstance(content, str) else content
        self.env_file.write_bytes(data)
        os.chmod(self.env_file, mode)

    def run(self, *args: str, rc: int = 0, extra: dict | None = None, use_fake: bool = True) -> subprocess.CompletedProcess:
        env = {
            **git_env(self.tmp),
            "TG_SCRAPER_ENV": str(self.env_file), "TG_SCRAPER_STATE": str(self.state),
            "TG_SCRAPER_GIT_URL": f"file://{self.src}", "TG_SCRAPER_LOCK": str(self.lock),
            "FAKE_DIR": str(self.fake_dir), "FAKE_RC": str(rc),
        }
        if use_fake:
            env["TG_SCRAPER_PYTHON"] = str(self.fake)
        env.update(extra or {})
        if self.fake_dir.exists():
            for f in self.fake_dir.iterdir():
                f.unlink()
        cp = subprocess.run(["sh", str(CRON_SH), *args], cwd=self.cwd, env=env, capture_output=True, text=True, timeout=120)
        out = cp.stdout + cp.stderr
        assert MARK not in out, "the DSN leaked into the wrapper's output"
        return cp

    def ran(self) -> bool:
        return (self.fake_dir / "argv").exists()

    def argv(self) -> list[str]:
        return (self.fake_dir / "argv").read_text().split("\0")[:-1]

    def dsn(self) -> str:
        return (self.fake_dir / "dsn").read_text()


@pytest.fixture()
def h(tmp_path) -> H:
    src = tmp_path / "src"
    src.mkdir()
    h = H(tmp=tmp_path, src=src, state=tmp_path / "state", env_file=tmp_path / "scraper.env",
          lock=tmp_path / "scraper.lock", fake=tmp_path / "fakepy", fake_dir=tmp_path / "fake", cwd=tmp_path / "cwd")
    h.cwd.mkdir()
    h.git("init", "-q", "-b", "main")
    # untracked .env in the source repo: the export must never carry it
    (src / ".env").write_text("DATABASE_URL=postgresql://dotenv-must-not-be-used\n")
    h.commit("print('v1')\n")
    h.fake.write_text(FAKE_PY)
    h.fake.chmod(0o755)
    h.write_env(f"DATABASE_URL={DSN}\n")
    return h


def lines(cp) -> list[str]:
    return [l for l in (cp.stdout + cp.stderr).splitlines() if l.strip()]


def wrapper_lines(cp) -> list[str]:
    return [l for l in lines(cp) if " tara-gala-scrape " in l]


def last_success(h: H) -> Path:
    return h.state / "last-success"


# --- config (B1, D1 to D3) ----------------------------------------------------------------------------

def test_missing_env_file_fails_config(h):
    h.env_file.unlink()
    cp = h.run()
    assert cp.returncode == 2
    assert any(f"FAILED config: {h.env_file} not found" in l for l in lines(cp))
    assert not h.ran()


@pytest.mark.parametrize("mode", [0o640, 0o644, 0o400])
def test_env_file_must_be_mode_600(h, mode):
    h.write_env(f"DATABASE_URL={DSN}\n", mode)
    cp = h.run()
    assert cp.returncode == 2
    msg = "\n".join(lines(cp))
    assert "FAILED config:" in msg and oct(mode)[2:] in msg
    assert not h.ran()


@pytest.mark.skipif(os.geteuid() != 0, reason="chown to another uid needs root")
def test_env_file_must_be_owned_by_the_runner(h):
    os.chown(h.env_file, 65534, -1)
    cp = h.run()
    assert cp.returncode == 2
    assert any("FAILED config:" in l for l in lines(cp))
    assert not h.ran()


@pytest.mark.parametrize("content", ["", "OTHER=1\n", "DATABASE_URL=\n", f"# DATABASE_URL={DSN}\n", f"export DATABASE_URL={DSN}\n"])
def test_no_database_url_line_fails_config(h, content):
    h.write_env(content)
    cp = h.run()
    assert cp.returncode == 2
    assert any(f"FAILED config: no DATABASE_URL in {h.env_file}" in l for l in lines(cp))
    assert not h.ran()


def test_crlf_line_ending_is_stripped(h):
    h.write_env(f"DATABASE_URL={DSN}\r\n".encode())
    assert h.run().returncode == 0
    assert h.dsn() == DSN


def test_first_database_url_line_wins(h):
    h.write_env(f"DATABASE_URL={DSN}\nDATABASE_URL=postgresql://second\n")
    assert h.run().returncode == 0
    assert h.dsn() == DSN


@pytest.mark.parametrize("args", [["--database-url", DSN], [f"--database-url={DSN}"], ["--dry-run", "--database-url", DSN]])
def test_database_url_argument_is_refused(h, args):
    cp = h.run(*args)
    assert cp.returncode == 2
    assert any("FAILED config: --database-url is not allowed; use the env file" in l for l in lines(cp))
    assert not h.ran()


def test_every_wrapper_line_has_the_log_format(h):
    for cp in (h.run(), h.run(rc=1), h.run("--database-url", "x")):
        out = lines(cp)
        assert out
        for line in out:
            assert LINE_RE.match(line), line


# --- success and propagation (B2, B3, B8) -------------------------------------------------------------

def test_success_runs_the_export_with_the_env_file_dsn(h):
    cp = h.run()
    assert cp.returncode == 0, cp.stdout
    out = wrapper_lines(cp)
    sha = h.git("rev-parse", "--short=12", "main")
    assert re.search(rf"START sha={sha}\b", out[0])
    assert re.search(r"END rc=0 duration_s=\d+$", out[-1])
    assert h.argv() == ["scraper/victory_liner.py"]
    assert (h.fake_dir / "cwd").read_text().strip() == str(h.state / "code")
    assert h.dsn() == DSN
    assert last_success(h).exists()


def test_export_is_clean(h):
    h.run()
    listing = (h.fake_dir / "ls").read_text().split()
    assert ".env" not in listing and ".git" not in listing
    assert {"scraper", "api"} <= set(listing)
    assert "dotenv-must-not-be-used" not in h.dsn()


def test_new_main_is_picked_up(h):
    h.run()
    new_sha = h.commit("print('v2')\n")
    cp = h.run()
    assert f"START sha={new_sha}" in wrapper_lines(cp)[0]
    assert (h.fake_dir / "script").read_text() == "print('v2')\n"
    assert (h.state / "code.old" / "scraper" / "victory_liner.py").read_text() == "print('v1')\n"
    assert not (h.state / "code.new").exists()


def test_env_file_beats_an_inherited_database_url(h):
    h.run(extra={"DATABASE_URL": "postgresql://inherited"})
    assert h.dsn() == DSN


@pytest.mark.parametrize("rc", [1, 2, 7])
def test_scraper_failure_is_propagated_and_logged(h, rc):
    h.run()
    before = last_success(h).stat().st_mtime_ns
    os.utime(last_success(h), ns=(before - 10**9, before - 10**9))
    before = last_success(h).stat().st_mtime_ns
    cp = h.run(rc=rc)
    assert cp.returncode == rc
    assert re.search(rf"END rc={rc} duration_s=\d+ FAILED$", wrapper_lines(cp)[-1])
    assert last_success(h).stat().st_mtime_ns == before


def test_first_run_failure_leaves_no_last_success(h):
    assert h.run(rc=1).returncode == 1
    assert not last_success(h).exists()


def test_arguments_pass_through_and_dry_run_does_not_count(h):
    cp = h.run("--dry-run", "--direction", "to-baguio")
    assert cp.returncode == 0
    assert h.argv() == ["scraper/victory_liner.py", "--dry-run", "--direction", "to-baguio"]
    assert not last_success(h).exists()


# --- secrets (B5, D2) ---------------------------------------------------------------------------------

def test_dsn_arrives_byte_for_byte_and_stays_out_of_state_files(h):
    h.run()
    assert h.dsn() == DSN
    for f in h.state.rglob("*"):
        if f.is_file() and "code" not in f.relative_to(h.state).parts[0]:
            assert MARK.encode() not in f.read_bytes(), f
    if h.lock.exists():
        assert MARK.encode() not in h.lock.read_bytes()


def test_env_file_is_parsed_never_executed(h):
    pwned, pwned2 = h.tmp / "pwned", h.tmp / "pwned2"
    h.write_env(f"DATABASE_URL=x$(touch {pwned})\ntouch {pwned2}\n")
    assert h.run().returncode == 0
    assert not pwned.exists() and not pwned2.exists()
    assert h.dsn() == f"x$(touch {pwned})"


# --- code source (B4) ----------------------------------------------------------------------------------

def test_fetch_failure_falls_back_to_the_previous_export(h):
    h.run()
    old = h.git("rev-parse", "--short=12", "main")
    cp = h.run(rc=3, extra={"TG_SCRAPER_GIT_URL": f"file://{h.tmp}/nope"})
    assert cp.returncode == 3
    assert any(f"WARNING code update failed; using sha={old}" in l for l in lines(cp))
    assert h.ran()


def test_missing_ref_falls_back_and_never_runs_half_written_code(h):
    h.run()
    cp = h.run(extra={"TG_SCRAPER_GIT_REF": "no-such-branch"})
    assert cp.returncode == 0
    assert any("WARNING code update failed" in l for l in lines(cp))
    assert (h.fake_dir / "script").read_text() == "print('v1')\n"
    assert not (h.state / "code.new").exists()
    assert h.run().returncode == 0  # a later good run still works


def test_fetch_failure_on_first_run_is_no_code(h):
    cp = h.run(extra={"TG_SCRAPER_GIT_URL": f"file://{h.tmp}/nope"})
    assert cp.returncode == 3
    assert any("FAILED no code" in l for l in lines(cp))
    assert not h.ran()


# --- venv (B9) --------------------------------------------------------------------------------------------

STUB_PY312 = """#!/bin/sh
# Stub python3.12: only "-m venv DIR" is expected. Builds a fake venv whose pip records its calls.
[ "$1" = "-m" ] && [ "$2" = "venv" ] || exit 9
echo venv >> "$CALLS"
mkdir -p "$3/bin"
cp "$FAKE_PY_PATH" "$3/bin/python"
cat > "$3/bin/pip" <<'EOF'
#!/bin/sh
echo "pip $*" >> "$CALLS"
exit "${PIP_RC:-0}"
EOF
chmod 755 "$3/bin/python" "$3/bin/pip"
"""


def test_venv_is_built_and_pip_runs_only_when_requirements_change(h):
    stub_dir = h.tmp / "stubbin"
    stub_dir.mkdir()
    (stub_dir / "python3.12").write_text(STUB_PY312)
    (stub_dir / "python3.12").chmod(0o755)
    calls = h.tmp / "calls"
    extra = {"PATH": f"{stub_dir}:{PATH}", "CALLS": str(calls), "FAKE_PY_PATH": str(h.fake)}
    record = lambda: calls.read_text().splitlines() if calls.exists() else []

    assert h.run(use_fake=False, extra=extra).returncode == 0
    assert record() == ["venv", "pip install -q -r api/requirements.txt"]
    assert h.ran()
    assert h.run(use_fake=False, extra=extra).returncode == 0
    assert record() == ["venv", "pip install -q -r api/requirements.txt"]  # unchanged: no pip
    h.commit("print('v1')\n", requirements="psycopg==3.2.*\nhttpx==0.27.*\n")
    assert h.run(use_fake=False, extra=extra).returncode == 0
    assert record()[-1] == "pip install -q -r api/requirements.txt" and len(record()) == 3
    h.commit("print('v1')\n", requirements="broken\n")
    cp = h.run(use_fake=False, extra={**extra, "PIP_RC": "1"})
    assert cp.returncode == 2
    assert any("FAILED venv" in l for l in lines(cp))
    assert not h.ran()


# --- lock and staleness (B6, B7) --------------------------------------------------------------------------

def test_a_held_lock_skips_the_run(h):
    with open(h.lock, "w") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        cp = h.run()
        assert cp.returncode == 75
        assert any("SKIPPED another run is in progress" in l for l in lines(cp))
        assert not h.ran()
    assert h.run().returncode == 0


def age(h: H, hours: float) -> None:
    t = time.time() - hours * 3600
    os.utime(last_success(h), (t, t))


def test_stale_last_success_warns_and_still_runs(h):
    h.run()
    age(h, 37)
    cp = h.run()
    assert cp.returncode == 0
    out = wrapper_lines(cp)
    warn = [i for i, l in enumerate(out) if "WARNING last successful scrape was 37 h ago" in l]
    start = [i for i, l in enumerate(out) if " START " in l]
    assert warn and start and warn[0] < start[0]


def test_recent_last_success_does_not_warn(h):
    h.run()
    age(h, 35)
    assert not any("WARNING" in l for l in lines(h.run()))


def test_no_success_after_an_earlier_export_warns(h):
    h.run(rc=1)
    cp = h.run()
    assert any("WARNING no successful scrape recorded yet" in l for l in lines(cp))
    assert not any("WARNING" in l for l in lines(h.run()))  # recorded now


def test_first_run_ever_does_not_warn(h):
    cp = h.run()
    assert cp.returncode == 0 and any(" START " in l for l in lines(cp))
    assert not any("WARNING" in l for l in lines(cp))


def test_state_dir_is_private(h):
    h.run()
    assert stat.S_IMODE(h.state.stat().st_mode) == 0o700


# --- static guards and logrotate --------------------------------------------------------------------------

def test_wrapper_never_sources_echoes_or_traces_the_env():
    src = CRON_SH.read_text()
    assert src.startswith("#!/bin/sh\n")
    assert re.search(r"^set -u$", src, re.M) and re.search(r"^umask 077$", src, re.M)
    code = "\n".join(l.split("#", 1)[0] if not l.lstrip().startswith("#") else "" for l in src.splitlines())
    assert not re.search(r"\beval\b", code)
    assert not re.search(r"(^|[;&|]\s*)(\.|source)\s+\S", code, re.M)
    assert not re.search(r"set -[a-z]*x", code)
    assert not re.search(r"(echo|printf|log)\b[^\n]*\$\{?(DSN|DATABASE_URL)\b", code)


def test_no_committed_file_holds_a_dsn():
    files = subprocess.run(["git", "-C", str(ROOT), "ls-files"], capture_output=True, text=True, check=True).stdout.split()
    assert not [f for f in files if f == ".env" or f.endswith(".env")]
    hits = subprocess.run(["git", "-C", str(ROOT), "grep", "-nE", r"postgres(ql)?://[^ ]*:[^ ]*@", "--", ".", ":!api/tests"],
                          capture_output=True, text=True).stdout
    # allowed: obvious placeholders like <password> in docs and .env.example
    real = [l for l in hits.splitlines() if not re.search(r"<[a-z-]+>|\.\.\.", l)]
    assert real == [], real


def test_logrotate_rule():
    text = LOGROTATE.read_text()
    assert text.splitlines()[0] == "/var/log/tara-gala-scraper.log {"
    for directive in ("weekly", "rotate 8", "compress", "delaycompress", "missingok", "notifempty", "create 0640 root adm"):
        assert re.search(rf"^\s+{directive}$", text, re.M), directive
    assert text.rstrip().endswith("}")


# --- README section 4 (B14) and the cron line -------------------------------------------------------------

def cron_section() -> str:
    readme = README.read_text()
    start = readme.index("### Daily run (cron)")
    end = readme.index("\n## ", start)
    return readme[start:end]


def test_readme_has_no_wrong_path():
    assert "/root/personal-projects" not in README.read_text()


def test_readme_cron_section_has_the_line_and_the_utc_reasoning():
    s = cron_section()
    assert CRON_LINE in s
    assert "20:00 UTC" in s and "04:00 Manila" in s
    assert "If the VPS clock is already Manila time" not in s
    assert "--database-url" not in s
    assert "crontab -e" in s


def test_readme_owner_steps():
    s = cron_section()
    assert "/root/.config/tara-gala-scraper.env" in s
    assert "chmod 600" in s or "install -m 600" in s
    assert not re.search(r"\bcat\b[^\n]*tara-gala-scraper\.env", s)
    assert "install -m 755" in s and "/usr/local/sbin/tara-gala-scrape" in s
    assert "/etc/logrotate.d/tara-gala-scraper" in s
    assert "grep -E 'START|END|FAILED|WARNING|SKIPPED' /var/log/tara-gala-scraper.log" in s
    assert "tara-gala-scrape --dry-run" in s


def test_readme_exit_codes_match_the_wrapper():
    s = cron_section()
    table = dict(re.findall(r"^\|\s*`?(\d+)`?\s*\|\s*([^|]+?)\s*\|$", s, re.M))
    assert set(table) == {"0", "1", "2", "3", "75"}, table
    src = CRON_SH.read_text()
    script_codes = set(re.findall(r"\b(?:fail|exit)\s+(\d+)\b", src))
    assert script_codes == {"2", "3", "75"}, script_codes
    assert script_codes <= set(table)


def test_cron_line_fires_at_4am_manila_every_day_of_the_trip():
    fields = CRON_LINE.split()
    minute, hour, dom, month, dow = fields[:5]
    assert (minute, hour, dom, month, dow) == ("0", "20", "*", "*", "*")
    assert fields[5] == "/usr/local/sbin/tara-gala-scrape"
    assert fields[6:] == [">>", "/var/log/tara-gala-scraper.log", "2>&1"]
    manila = ZoneInfo("Asia/Manila")
    day = date(2026, 10, 28)
    while day <= date(2026, 11, 10):
        fire = datetime(day.year, day.month, day.day, 20, 0, tzinfo=timezone.utc).astimezone(manila)
        assert (fire.date(), fire.hour, fire.minute) == (day + timedelta(days=1), 4, 0)
        day += timedelta(days=1)
