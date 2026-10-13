#!/usr/bin/env python3
"""test-self-heal.py — guard the guard.

Asserts the self-heal harness itself is structurally sound: every check returns a valid
finding shape, meters return valid shape, fault-isolation actually isolates, and the
command-check registry parses into callables. A broken check is a silent blind spot — this
catches it. Registered AS a self-heal check (self-heal-selftest) so the harness verifies
itself every morning.

Exits 0 on pass, 1 on failure (prints the failures). Does NOT execute registry command-
checks (one of them is this test → would recurse); it only validates they build.
"""
import importlib.util, os, sys

REPO = os.path.realpath(os.path.join(os.path.dirname(__file__), ".."))
spec = importlib.util.spec_from_file_location("selfheal", os.path.join(REPO, "scripts", "self-heal.py"))
sh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sh)

VALID_HEAL = {sh.OK, sh.HEALED, sh.NEEDS_HUMAN}
VALID_METER = {sh.PASS, sh.ALERT}
fails = []


def ok_shape(r, valid_status, where, required=("name", "status", "detail")):
    if not isinstance(r, dict):
        fails.append(f"{where}: not a dict ({type(r).__name__})"); return
    for k in required:
        if k not in r:
            fails.append(f"{where}: missing key {k!r}")
    if r.get("status") not in valid_status:
        fails.append(f"{where}: bad status {r.get('status')!r}")


# 1. every function check returns a valid finding (dry-run, fault-isolated)
for fn in sh.HEALS:
    ok_shape(sh.run_check(fn, False), VALID_HEAL, f"HEALS::{getattr(fn,'__name__','?')}",
             required=("name", "status", "detail", "actions"))

# 2. every meter returns a valid shape (meters carry PASS/ALERT, not heal statuses)
recs = sh._load_gate_log(24)
for fn in sh.METERS:
    ok_shape(fn(recs), VALID_METER, f"METERS::{getattr(fn,'__name__','?')}")

# 3. fault-isolation actually isolates a throwing check
def _boom(apply):
    raise RuntimeError("boom")
r = sh.run_check(_boom, False)
if r.get("status") != sh.NEEDS_HUMAN or "ERROR" not in r.get("detail", "").upper():
    fails.append(f"fault-isolation broken: thrower not captured → {r}")

# 4. command-check registry parses into callables (build only — never execute, would recurse)
cmds = sh.load_command_checks()
if not isinstance(cmds, list):
    fails.append("load_command_checks did not return a list")
for c in cmds:
    if not callable(c):
        fails.append(f"command-check not callable: {c!r}")

# 5. memory-index-pressure (#757 interim guard): size branches behave, not just shape
import tempfile as _tf
_orig_idx = sh.MEMORY_INDEX
_small = None
try:
    with _tf.NamedTemporaryFile("w", suffix=".md", delete=False) as _f:
        _f.write("- x.md — under the soft cap\n")
        _small = _f.name
    sh.MEMORY_INDEX = _small
    r = sh.check_memory_index_pressure(False)
    if r.get("status") != sh.OK:
        fails.append(f"memory-index-pressure: small index not OK → {r.get('status')}")
    with open(_small, "w") as _f:
        _f.write("- x.md — " + "z" * (sh.MEMORY_SOFT_CAP + 100) + "\n")  # over soft cap
    r = sh.check_memory_index_pressure(False)  # dry-run: report only, never writes
    if r.get("status") != sh.NEEDS_HUMAN:
        fails.append(f"memory-index-pressure: over-cap dry-run not NEEDS_HUMAN → {r.get('status')}")
    if not any("memory-maintain" in a for a in r.get("actions", [])):
        fails.append("memory-index-pressure: over-cap finding omits the maintainer remediation")
finally:
    sh.MEMORY_INDEX = _orig_idx
    if _small:
        try:
            os.unlink(_small)
        except OSError:
            pass

# 6. memory-pressure (#780): stays green on a healthy host, WARNs (agent-tier, names top
# RSS) under genuine pressure. sh() is stubbed so the branches are deterministic.
def _fake_mem_sh(healthy):
    def f(cmd, timeout=60):
        if cmd[0] == "vm_stat":
            hdr = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n"
            if healthy:  # ~1.6GB available
                return 0, hdr + "Pages free:  40000.\nPages inactive:  60000.\nPages speculative:  1000.\n"
            return 0, hdr + "Pages free:  100.\nPages inactive:  200.\nPages speculative:  0.\n"  # ~5MB
        if "vm.swapusage" in cmd:
            return (0, "total = 2048.00M  used = 100.00M  free = 1948.00M") if healthy \
                else (0, "total = 4096.00M  used = 3700.00M  free = 396.00M")  # 90%
        if cmd[0] == "ps":
            return 0, "  RSS COMM\n500000 /Applications/Foo.app/Contents/MacOS/Foo\n300000 bar\n"
        return 1, ""
    return f

if sys.platform == "darwin":
    _orig_mem_sh = sh.sh
    try:
        sh.sh = _fake_mem_sh(healthy=True)
        r = sh.check_memory_pressure(False)
        if r.get("status") != sh.OK:
            fails.append(f"memory-pressure: healthy host not OK → {r.get('status')} ({r.get('detail')})")
        sh.sh = _fake_mem_sh(healthy=False)
        r = sh.check_memory_pressure(False)
        if r.get("status") != sh.NEEDS_HUMAN:
            fails.append(f"memory-pressure: starved host not NEEDS_HUMAN → {r.get('status')}")
        if "Foo" not in r.get("detail", ""):
            fails.append("memory-pressure: starved finding omits the top RSS consumers")
        if r.get("escalation") != sh.AGENT:
            fails.append("memory-pressure: pressure finding must be agent-tier (worklist, not Ant ping)")
    finally:
        sh.sh = _orig_mem_sh
else:
    if sh.check_memory_pressure(False).get("status") != sh.OK:
        fails.append("memory-pressure: non-macOS host should skip to OK")

# 7. gitsync-drift stash-drain verdict (#1026 follow-on): a SUCCESSFUL daemon-stash drain must
# report HEALED even when check-sync-drift.sh still exits non-zero on an unrelated stale
# HEARTBEAT — the mislabel that stamped 14 straight days of good drains "auto-reconcile failed"
# (worklist 2026-07-14→27). Success is judged by "STASH:" being gone, not the drift exit code.
# A genuinely-remaining "STASH:" line must still be NEEDS_HUMAN "auto-reconcile failed".
def _fake_gitsync_sh(stash_cleared_after):
    state = {"drift_calls": 0}
    def f(cmd, timeout=60):
        joined = " ".join(cmd) if isinstance(cmd, (list, tuple)) else str(cmd)
        if "check-sync-drift.sh" in joined:
            state["drift_calls"] += 1
            if state["drift_calls"] == 1:  # pre-reconcile: stashes present + stale heartbeat
                return 1, ("STASH: 5 orphaned daemon stashes accumulated (>= 2) — a stash-pop has been failing.\n"
                           "HEARTBEAT: last successful sync was 47m ago (> 15m) — sync may be dead.")
            if stash_cleared_after:  # post-reconcile: STASH gone, heartbeat STILL stale (rc=1)
                return 1, ("HEARTBEAT: last successful sync was 47m ago (> 15m) — sync may be dead.\n"
                           "OK: all .gitattributes merge drivers are registered in git config")
            return 1, "STASH: 5 orphaned daemon stashes accumulated (>= 2) — a stash-pop has been failing."
        if "reconcile-daemon-stashes.py" in joined:
            return 0, "  archived stash@{1} -> stash-archive/<<MACHINE_2_USER>>/x (pushed)\n  dropped stash@{1}"
        return 0, ""
    return f

_orig_gitsync_sh = sh.sh
try:
    sh.sh = _fake_gitsync_sh(stash_cleared_after=True)
    r = sh.check_gitsync_drift(True)
    if r.get("status") != sh.HEALED:
        fails.append(f"gitsync-drift: cleared drain w/ stale heartbeat must be HEALED, not {r.get('status')} ({r.get('detail')})")
    sh.sh = _fake_gitsync_sh(stash_cleared_after=False)
    r = sh.check_gitsync_drift(True)
    if r.get("status") != sh.NEEDS_HUMAN or "auto-reconcile failed" not in r.get("detail", ""):
        fails.append(f"gitsync-drift: remaining STASH must stay NEEDS_HUMAN 'auto-reconcile failed', got {r.get('status')} ({r.get('detail')})")
finally:
    sh.sh = _orig_gitsync_sh

# 8. task-counter I6 auto-heal (#1607): the id counter must never sit below the max task id
# or the next create-task mints a colliding id (the 2026-07-31 fleet incident). heal_task_counter
# bumps it UP to the max id (mechanical/safe/forward) and commits under git-lock. Sandbox the
# state dir + stub the commit so the branches are deterministic and touch no real state.
import json as _json, tempfile as _tf2, shutil as _shutil

_counter_repos = []

def _mk_counter_repo(last_assigned, task_ids, archived=()):
    d = _tf2.mkdtemp()
    _counter_repos.append(d)
    state = os.path.join(d, "docs", "process", "state")
    os.makedirs(state)
    with open(os.path.join(state, "task-counter.json"), "w") as _f:
        _json.dump({"lastAssigned": last_assigned, "updatedAt": "2026-07-30T00:00:00Z"}, _f)
    with open(os.path.join(state, "tasks.json"), "w") as _f:
        _json.dump({"tasks": [{"taskId": f"#{i}"} for i in task_ids],
                    "archivedIds": [f"#{i}" for i in archived]}, _f)
    return d

def _counter_val(repo):
    with open(os.path.join(repo, "docs", "process", "state", "task-counter.json")) as _f:
        return _json.load(_f)["lastAssigned"]

_orig_counter_repo, _orig_counter_sh = sh.REPO, sh.sh
_commit_calls = []

def _fake_counter_sh(cmd, timeout=60):
    _commit_calls.append(cmd)   # stub the git-lock commit so no real git is touched
    return 0, ""

try:
    sh.sh = _fake_counter_sh
    # A. counter lags (1502) below max id (#1593) + apply -> HEALED, bumped, committed
    sh.REPO = _mk_counter_repo(1502, [1500, 1593])
    r = sh.heal_task_counter(True)
    if r.get("status") != sh.HEALED:
        fails.append(f"task-counter: lag+apply must be HEALED, got {r.get('status')} ({r.get('detail')})")
    if _counter_val(sh.REPO) != 1593:
        fails.append(f"task-counter: apply must bump lastAssigned to 1593, got {_counter_val(sh.REPO)}")
    if not _commit_calls:
        fails.append("task-counter: apply must commit the bump under git-lock")
    # A2. an archived tombstone counts as an allocated id (must never be re-issued)
    sh.REPO = _mk_counter_repo(1502, [1500], archived=[1610])
    sh.heal_task_counter(True)
    if _counter_val(sh.REPO) != 1610:
        fails.append(f"task-counter: archived tombstone #1610 must raise the counter, got {_counter_val(sh.REPO)}")
    # B. counter healthy (>= max id) -> OK, no bump
    sh.REPO = _mk_counter_repo(1600, [1500, 1593])
    r = sh.heal_task_counter(True)
    if r.get("status") != sh.OK:
        fails.append(f"task-counter: healthy counter must be OK, got {r.get('status')}")
    if _counter_val(sh.REPO) != 1600:
        fails.append("task-counter: healthy counter must not be modified")
    # C. lag + dry-run -> NEEDS_HUMAN, file untouched
    sh.REPO = _mk_counter_repo(1502, [1593])
    r = sh.heal_task_counter(False)
    if r.get("status") != sh.NEEDS_HUMAN:
        fails.append(f"task-counter: lag dry-run must be NEEDS_HUMAN, got {r.get('status')}")
    if _counter_val(sh.REPO) != 1502:
        fails.append("task-counter: dry-run must not modify the counter file")
finally:
    sh.REPO, sh.sh = _orig_counter_repo, _orig_counter_sh
    for _d in _counter_repos:
        try:
            _shutil.rmtree(_d)
        except OSError:
            pass

# N. unpruned-dirs (#4413): BEHAVIOUR, not just shape. The check above only proves it returns
# a valid finding; nothing proved it still flags anything, so a refactor could quietly turn it
# into a permanent OK -- which is exactly how the cleaners it watches rotted. Both leak shapes
# are covered because they are caught by different tests: slow leaks are majority-STALE, fast
# leaks are ALL-RECENT and only trip the absolute ceiling (<<MACHINE_2_ID>>'s 45,829 orphans passed a
# staleness-only check). Thresholds are lowered via env so this stays cheap enough for the
# daily selftest -- the logic is identical at 12 files or 12,000.
import shutil as _u_shutil, tempfile as _u_tf, time as _u_time
_u_env = {k: os.environ.get(k) for k in
          ("METIS_UNPRUNED_MIN_FILES", "METIS_UNPRUNED_STALE_DAYS",
           "METIS_UNPRUNED_STALE_FRAC", "METIS_UNPRUNED_CEILING")}
_u_home = os.environ.get("HOME")
_u_root = _u_tf.mkdtemp(prefix="unpruned-test-")


def _u_seed(rel, n, n_old):
    d = os.path.join(_u_root, rel)
    os.makedirs(d, exist_ok=True)
    old, fresh = _u_time.time() - 90 * 86400, _u_time.time() - 3600
    for i in range(n):
        f = os.path.join(d, "m%04d.json" % i)
        with open(f, "w") as fh:
            fh.write("x")
        t = old if i < n_old else fresh
        os.utime(f, (t, t))


try:
    os.environ["METIS_UNPRUNED_MIN_FILES"] = "5"
    os.environ["METIS_UNPRUNED_STALE_DAYS"] = "45"
    os.environ["METIS_UNPRUNED_STALE_FRAC"] = "0.5"
    os.environ["METIS_UNPRUNED_CEILING"] = "20"
    os.environ["HOME"] = _u_root

    # healthy only: over the size floor but all recent and under the ceiling
    _u_seed(".openclaw/agents/smith/sessions", 10, 0)
    r = sh.check_unpruned_dirs(False)
    if r.get("status") != sh.OK:
        fails.append(f"unpruned-dirs: healthy recent dir must be OK -> {r.get('status')} {r.get('actions')}")

    # slow leak: majority-stale
    _u_seed(".claude/file-activity", 10, 8)
    r = sh.check_unpruned_dirs(False)
    if r.get("status") != sh.NEEDS_HUMAN:
        fails.append(f"unpruned-dirs: majority-stale dir must flag -> {r.get('status')}")
    if not any("file-activity" in a for a in r.get("actions", [])):
        fails.append("unpruned-dirs: stale finding does not name the offending dir")
    if any("smith" in a for a in r.get("actions", [])):
        fails.append("unpruned-dirs: healthy dir flagged alongside the stale one")

    # fast leak: ALL-RECENT, over the ceiling -- staleness alone would pass this
    _u_shutil.rmtree(os.path.join(_u_root, ".claude", "file-activity"))
    _u_seed(".claude/file-activity", 25, 0)
    r = sh.check_unpruned_dirs(False)
    if r.get("status") != sh.NEEDS_HUMAN:
        fails.append(f"unpruned-dirs: all-recent dir over ceiling must flag -> {r.get('status')}")
    if not any("ceiling" in a for a in r.get("actions", [])):
        fails.append("unpruned-dirs: ceiling finding does not explain the fast-leak case")

    # package trees are large and old by nature -- must never be flagged
    _u_shutil.rmtree(os.path.join(_u_root, ".claude", "file-activity"))
    _u_seed(".openclaw/tts/venv/lib/python3.12/site-packages/torch", 30, 30)
    r = sh.check_unpruned_dirs(False)
    if any("torch" in a for a in r.get("actions", [])):
        fails.append("unpruned-dirs: excluded package tree was flagged")
finally:
    os.environ["HOME"] = _u_home if _u_home is not None else ""
    for _k, _v in _u_env.items():
        if _v is None:
            os.environ.pop(_k, None)
        else:
            os.environ[_k] = _v
    try:
        _u_shutil.rmtree(_u_root)
    except OSError:
        pass

# N+1. routing projection (#4425): evicted ledger records must survive as slim routing rows.
# The failure this guards is specific and already happened once: a 474-call eval burst evicted
# all but 26 production records from the 500-record ledger, and no routing question could be
# answered afterwards. Assert the PRODUCTION rows survive the eviction and the heavy fields do
# not, because a projection that silently drops either is indistinguishable from no projection.
import json as _r_json, shutil as _r_shutil, tempfile as _r_tf
_r_home, _r_keep = os.environ.get("HOME"), os.environ.get("METIS_DISPATCH_LEDGER_KEEP")
_r_root = _r_tf.mkdtemp(prefix="routing-proj-test-")
try:
    _r_fd = os.path.join(_r_root, ".openclaw", "feedback")
    os.makedirs(_r_fd)
    _r_led = os.path.join(_r_fd, "dispatch-corrections.jsonl")
    _r_out = os.path.join(_r_fd, "dispatch-routing.jsonl")
    _r_big = "x" * 4000
    with open(_r_led, "w") as _fh:
        for _i in range(10):   # production, oldest -> evicted first
            _fh.write(_r_json.dumps({"ts": "2026-08-20T10:00:00-0700", "role": "warden",
                "engine": "qwen-shallow", "elapsed_s": 12.5, "ok": True,
                "route_reason": "high-risk proposal-only draft", "traffic": "production",
                "task_features": {"work_type": "review"}, "task": "review the auth change",
                "output": _r_big, "mission_packet": _r_big}) + "\n")
        for _i in range(25):   # the eval burst
            _fh.write(_r_json.dumps({"ts": "2026-08-22T15:00:00-0700", "role": "scout",
                "engine": "5.4-standard", "elapsed_s": 8.4, "ok": True,
                "route_reason": "explicit engine", "traffic": "eval",
                "task": "STRICT JSON judge probe",
                "output": _r_big, "mission_packet": _r_big}) + "\n")
    os.environ["HOME"] = _r_root
    os.environ["METIS_DISPATCH_LEDGER_KEEP"] = "25"
    sh.heal_log_rotation(True)
    if sum(1 for _ in open(_r_led)) != 25:
        fails.append("routing-projection: ledger not tail-kept to 25")
    if not os.path.exists(_r_out):
        fails.append("routing-projection: no routing ledger written -- evicted records lost")
    else:
        _r_rows = [_r_json.loads(_l) for _l in open(_r_out)]
        _r_prod = [x for x in _r_rows if x.get("role") == "warden"]
        if len(_r_prod) != 10:
            fails.append(f"routing-projection: production rows lost -> {len(_r_prod)} of 10")
        if any("output" in x or "mission_packet" in x for x in _r_rows):
            fails.append("routing-projection: heavy fields not stripped (defeats the whole point)")
        if _r_prod and not _r_prod[0].get("route_reason"):
            fails.append("routing-projection: route_reason dropped -- routing signal is gone")
        if _r_rows and "task_head" not in _r_rows[0]:
            fails.append("routing-projection: task_head dropped -- cannot separate eval from production")
        # #4489: `traffic` is the SOURCE-marked separator. task_head only lets a human squint at
        # the prompt and guess; this field is the one an automated routing query can filter on,
        # so dropping it in the projection puts every future analysis back to inferring.
        if _r_prod and _r_prod[0].get("traffic") != "production":
            fails.append("routing-projection: traffic marker dropped -- eval and production "
                         "become indistinguishable again (the #4489 regression)")
        if any("traffic" not in x for x in _r_rows):
            fails.append("routing-projection: some projected rows carry no traffic marker")
finally:
    os.environ["HOME"] = _r_home if _r_home is not None else ""
    if _r_keep is None:
        os.environ.pop("METIS_DISPATCH_LEDGER_KEEP", None)
    else:
        os.environ["METIS_DISPATCH_LEDGER_KEEP"] = _r_keep
    try:
        _r_shutil.rmtree(_r_root)
    except OSError:
        pass

# --- launchd-job-failing: the four decisions that make it a signal, not noise (#4553) ---
# Written because the first version of this check scoped to the DECLARED roster and
# returned a clean OK on the very machine carrying the failure — the undeclared strays
# are exactly what it exists to find. Each case below is one way to go blind again.
_LIST = """PID\tStatus\tLabel
-\t78\tant.notion-tag-intake-v2
-\t255\tant.keepalive-tunnel
-\t-9\tant.reaped-by-signal
-\t0\tant.healthy
-\t1\tcom.apple.Siri.agent
"""


def _run_jobfail(keepalive_labels):
    real_sh, real_ka = sh.sh, sh._launchd_keepalive
    sh.sh = lambda cmd, **kw: (0, _LIST) if "launchctl list" in " ".join(cmd) else (0, "")
    sh._launchd_keepalive = lambda label: label in keepalive_labels
    try:
        return sh.check_launchd_job_failing(False)
    finally:
        sh.sh, sh._launchd_keepalive = real_sh, real_ka


r = _run_jobfail({"ant.keepalive-tunnel"})
d = r.get("detail", "")
if r.get("status") != sh.NEEDS_HUMAN:
    fails.append(f"launchd-job-failing: a job exiting 78 was not reported ({r.get('status')})")
if "ant.notion-tag-intake-v2" not in d:
    fails.append("launchd-job-failing: the positive-exit job is missing from the detail")
if "not declared here" not in d:
    fails.append("launchd-job-failing: an undeclared stray was not labelled as one — that "
                 "distinction is the whole diagnosis (another host's plist installed here)")
if "ant.keepalive-tunnel" in d:
    fails.append("launchd-job-failing: a KeepAlive job was flagged — launchd restarts it "
                 "forever by design, so nonzero means 'not yet', and flagging it is permanent noise")
if "ant.reaped-by-signal" in d:
    fails.append("launchd-job-failing: a NEGATIVE status was flagged — that is a signal "
                 "(-9 = SIGKILL, which macOS uses to reap idle agents), not a failure")
if "ant.healthy" in d:
    fails.append("launchd-job-failing: a job exiting 0 was flagged")
if "Siri" in d or "com.apple" in d:
    fails.append("launchd-job-failing: an Apple label was flagged — out of our namespace")

# Without the KeepAlive exemption the tunnel must show up, or the exemption is untested.
if "ant.keepalive-tunnel" not in _run_jobfail(set()).get("detail", ""):
    fails.append("launchd-job-failing: the KeepAlive exemption is not what suppresses the "
                 "tunnel — something else is, so the test proves nothing")

# --- state-surface-contradictions: what counts, and what must NOT (#4464) ---
# Every exclusion below was measured on the live board first. queued-with-a-blocker (52
# rows) and needs_verification-with-a-blocker (11 rows) are normal state, and including
# either would have made them the bulk of the output. The blocker prefix test matters
# too: the board holds "none — awaiting Ant", which a != "none" comparison reports as
# blocked (18 false findings before it was tightened).
_BOARD = {"tasks": [
    {"taskId": "#1", "state": "done",     "title": "alpha", "nextAction": "keep going"},
    {"taskId": "#2", "state": "dropped",  "title": "beta",  "nextAction": "none"},
    {"taskId": "#3", "state": "queued",   "title": "gamma", "blockerOrNone": "needs Ant"},
    {"taskId": "#4", "state": "needs_verification", "title": "delta",
     "blockerOrNone": "awaiting a human browser session"},
    {"taskId": "#5", "state": "in_progress", "title": "epsilon",
     "blockerOrNone": "none — awaiting Ant"},
    {"taskId": "#6", "state": "blocked",  "title": "zeta",  "blockerOrNone": "none"},
    {"taskId": "#7", "state": "queued",   "title": "dupe"},
    {"taskId": "#8", "state": "queued",   "title": "Dupe"},
    # #9 reuses a LIVE row's title (#3 "gamma") but is itself closed. That is history,
    # not duplication, and must not be counted: counting it reported 61 dupes on the
    # real board where only 1 pair was actually live.
    {"taskId": "#9", "state": "dropped",  "title": "gamma", "nextAction": "none"},
]}


def _run_surface(board):
    import json as _json, os as _os, tempfile
    real_repo = sh.REPO
    d = tempfile.mkdtemp()
    _os.makedirs(_os.path.join(d, "docs", "process", "state"))
    with open(_os.path.join(d, "docs", "process", "state", "tasks.json"), "w") as fh:
        _json.dump(board, fh)
    sh.REPO = d
    try:
        return sh.check_state_surface_contradictions(False)
    finally:
        sh.REPO = real_repo


r = _run_surface(_BOARD)
d = r.get("detail", "")
if r.get("status") != sh.NEEDS_HUMAN:
    fails.append(f"state-surface: a board with real contradictions reported {r.get('status')} — "
                 "note this check FAILS OPEN on an unreadable board, so a code bug inside it "
                 "looks exactly like a clean board")
if "1 terminal rows carry a live nextAction" not in d:
    fails.append(f"state-surface: expected exactly 1 terminal-with-nextAction (#1 only; #2 "
                 f"carries 'none'), got: {d}")
if "1 titles appear on more than one live row" not in d:
    fails.append(f"state-surface: expected ONLY the live case-insensitive dupe/Dupe pair — #9 is\n"
                 f"                dropped and reuses live #3's title, which is history: {d}")
if "1 blocked row(s) name no blocker" not in d:
    fails.append(f"state-surface: expected #6 (blocked, blockerOrNone 'none'), got: {d}")
if "in_progress rows carry a blocker" in d:
    fails.append("state-surface: #5's blocker reads 'none — awaiting Ant' and was counted as "
                 "a real blocker — the prefix test is what stops 18 false findings")

# A board with none of the four must come back OK, or the check is unconditional noise.
_CLEAN = {"tasks": [
    {"taskId": "#1", "state": "done", "title": "alpha", "nextAction": "none"},
    {"taskId": "#3", "state": "queued", "title": "gamma", "blockerOrNone": "needs Ant"},
    {"taskId": "#4", "state": "needs_verification", "title": "delta",
     "blockerOrNone": "awaiting a human browser session"},
    {"taskId": "#5", "state": "done", "title": "gamma", "nextAction": "none"},
]}
r2 = _run_surface(_CLEAN)
if r2.get("status") != sh.OK:
    fails.append(f"state-surface: a clean board was flagged — queued-with-blocker and "
                 f"needs_verification-with-blocker are normal: {r2.get('detail')}")

# The gate belongs at the END. It used to sit mid-file, and the two blocks added after
# it (launchd-job-failing, state-surface-contradictions) appended to `fails` that nothing
# read again — the suite printed OK and exited 0 with real assertions failing underneath.
# That is the same shape this whole check family exists to catch: a routine that runs,
# reports success, and never looks at what it collected. So the suite also checks itself.
_src = open(__file__, encoding="utf-8").read().splitlines()
_gate_line = max(i for i, l in enumerate(_src) if l.startswith("if fails:"))
_late = [i + 1 for i, l in enumerate(_src)
         if "fails.append(" in l and not l.lstrip().startswith("#") and i > _gate_line]
if _late:
    fails.append(f"assertions at line(s) {_late} run AFTER the fails gate at line "
                 f"{_gate_line + 1} — they can never fail the suite. Move the gate down.")

if fails:
    print("SELF-HEAL SELFTEST FAILED:")
    for f in fails:
        print("  -", f)
    sys.exit(1)

print(f"SELF-HEAL SELFTEST OK — {len(sh.HEALS)} checks + {len(sh.METERS)} meters + {len(cmds)} command-checks, shapes valid, fault-isolation works")
sys.exit(0)
