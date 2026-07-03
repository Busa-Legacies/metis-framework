#!/usr/bin/env python3
"""Regression test for scripts/lib/infra_config.py config resolution.

Covers the REPO_ROOT > METIS_HOME > METIS_CORE > file-location precedence (aligned
with agent-work.py / free-work.py ROOT resolution, #451/#283) plus placeholder
filtering and detect_machine override/fallback. Runs the module's CLI shim in a
subprocess so _HOME (resolved at import time from env) is exercised the real way.

Self-contained, no external deps. Exit 0 = all pass.
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

SHIM = str(Path(__file__).resolve().parent / "lib" / "infra_config.py")
PASS, FAIL = 0, 0


def _write_config(root: Path, machines, agents=None):
    (root / "config").mkdir(parents=True, exist_ok=True)
    cfg = {"machines": machines, "agents": agents or {"all": ["claude"]}}
    (root / "config" / "infrastructure.json").write_text(json.dumps(cfg))


def run(cmd_arg, env_overrides):
    env = {k: v for k, v in os.environ.items()
           if k not in ("REPO_ROOT", "METIS_HOME", "METIS_CORE", "METIS_MACHINE", "FREE_WORK_MACHINE")}
    env.update(env_overrides)
    r = subprocess.run([sys.executable, SHIM, *cmd_arg.split()],
                       capture_output=True, text=True, env=env, timeout=30)
    return r.stdout.strip()


def check(name, got, want):
    global PASS, FAIL
    if got == want:
        PASS += 1
        print(f"  PASS {name}: {got!r}")
    else:
        FAIL += 1
        print(f"  FAIL {name}: got {got!r} want {want!r}")


def main():
    with tempfile.TemporaryDirectory() as td:
        A = Path(td) / "repoA"
        B = Path(td) / "repoB"
        T = Path(td) / "tmpl"
        _write_config(A, [{"id": "aaa", "role": "primary", "user": "alice"}])
        _write_config(B, [{"id": "bbb", "role": "primary", "user": "bob"}])
        _write_config(T, [{"id": "<<MACHINE_1_ID>>", "role": "primary"}])  # placeholders

        # 1. precedence: REPO_ROOT wins over METIS_HOME
        check("REPO_ROOT > METIS_HOME",
              run("primary-machine", {"REPO_ROOT": str(A), "METIS_HOME": str(B)}), "aaa")
        # 2. METIS_HOME used when REPO_ROOT unset
        check("METIS_HOME when no REPO_ROOT",
              run("primary-machine", {"METIS_HOME": str(B)}), "bbb")
        # 3. REPO_ROOT alone
        check("REPO_ROOT alone",
              run("primary-machine", {"REPO_ROOT": str(A)}), "aaa")
        # 4. placeholder config -> generic 'primary' fallback (machines filtered out)
        check("placeholder -> primary",
              run("primary-machine", {"REPO_ROOT": str(T)}), "primary")
        # 5. detect_machine: explicit METIS_MACHINE override wins
        check("METIS_MACHINE override",
              run("detect-machine", {"REPO_ROOT": str(A), "METIS_MACHINE": "work-laptop"}), "work-laptop")
        # 6. detect_machine: exact unix-user match resolves the right id
        check("user match -> id",
              run("detect-machine", {"REPO_ROOT": str(A), "USER": "alice"}), "aaa")
        # 7. detect_machine: no signal match -> primary fallback (declared, not generic)
        check("no match -> declared primary",
              run("detect-machine", {"REPO_ROOT": str(B), "USER": "nobody-xyz"}), "bbb")

    print(f"\ninfra_config: {PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
