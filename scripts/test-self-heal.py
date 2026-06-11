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

if fails:
    print("SELF-HEAL SELFTEST FAILED:")
    for f in fails:
        print("  -", f)
    sys.exit(1)
print(f"SELF-HEAL SELFTEST OK — {len(sh.HEALS)} checks + {len(sh.METERS)} meters + {len(cmds)} command-checks, shapes valid, fault-isolation works")
sys.exit(0)
