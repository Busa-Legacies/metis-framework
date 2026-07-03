#!/usr/bin/env python3
"""add-healthcheck.py — register a bug as a permanent self-heal check (one command).

The loop closer: every time we fix a mechanically-detectable bug, we run this to add a
regression check to the daily self-heal harness. The check lives in the repo-tracked
registry (docs/process/state/health-checks.json), runs every morning, and routes to the
worklist (or @Ant, if --tier ant) when it ever trips again. No python editing; syncs to
every machine.

The check is COMMAND-based: a shell command that exits 0 when healthy, non-zero when the
bug has regressed. Write the command to FAIL on the broken state you just fixed.

Usage:
  scripts/add-healthcheck.py NAME --cmd "<shell test>" [options]

Options:
  --cmd STR          shell command; exit ok-exit = healthy, else = finding (required)
  --heal STR         shell command to auto-fix on failure (then re-checks); only safe,
                     idempotent, reversible fixes belong here — else leave it to the worklist
  --tier T           auto|agent|ant  (default agent — worklist, never pings Ant)
  --bug-ref STR      the bug this guards (#NNN or commit) — shown when it trips
  --fail-detail STR  one-line description shown when the check fails
  --ok-detail STR    one-line shown when healthy (optional)
  --ok-exit N        exit code that means healthy (default 0)
  --timeout N        seconds (default 60)
  --action STR       remediation hint shown on failure (repeatable)
  --update           overwrite an existing check of the same name
  --no-test          skip the one-shot run that confirms the command executes

On add it RUNS the command once (unless --no-test) so you see it works before it ships.

If a bug is NOT mechanically detectable, don't force a check — record a detector-gap:
  scripts/add-healthcheck.py NAME --gap "why it can't be auto-detected yet"
"""
import argparse, json, os, subprocess, sys, datetime, re

REPO = os.path.realpath(os.path.join(os.path.dirname(__file__), ".."))
REGISTRY = os.path.join(REPO, "docs", "process", "state", "health-checks.json")


def load():
    try:
        return json.load(open(REGISTRY))
    except Exception:
        return {"version": 1,
                "_README": "Bug-derived self-heal checks. Add via scripts/add-healthcheck.py "
                           "(don't hand-edit). Each fix that's mechanically detectable lands "
                           "one entry here; self-heal.py runs them daily. See "
                           "docs/process/self-heal-protocol.md.",
                "checks": [], "gaps": []}


def save(reg):
    reg["updatedAt"] = datetime.datetime.now().isoformat(timespec="seconds")
    os.makedirs(os.path.dirname(REGISTRY), exist_ok=True)
    json.dump(reg, open(REGISTRY, "w"), indent=2)


def main():
    ap = argparse.ArgumentParser(description="register a self-heal regression check")
    ap.add_argument("name")
    ap.add_argument("--cmd")
    ap.add_argument("--heal", default="", help="auto-fix command run on failure (safe/idempotent only)")
    ap.add_argument("--tier", default="agent", choices=["auto", "agent", "ant"])
    ap.add_argument("--bug-ref", default="")
    ap.add_argument("--fail-detail", default="")
    ap.add_argument("--ok-detail", default="")
    ap.add_argument("--ok-exit", type=int, default=0)
    ap.add_argument("--timeout", type=int, default=60)
    ap.add_argument("--action", action="append", default=[])
    ap.add_argument("--update", action="store_true")
    ap.add_argument("--no-test", action="store_true")
    ap.add_argument("--gap", help="record a detector-gap instead of a check (not mechanically detectable)")
    args = ap.parse_args()

    if not re.match(r"^[a-z0-9][a-z0-9-]*$", args.name):
        sys.exit(f"name must be kebab-case [a-z0-9-]: {args.name!r}")

    reg = load()
    reg.setdefault("checks", []); reg.setdefault("gaps", [])
    now = datetime.datetime.now().isoformat(timespec="seconds")

    # --- detector-gap path: track bugs we can't auto-detect yet, so they're not lost ---
    if args.gap:
        reg["gaps"] = [g for g in reg["gaps"] if g.get("name") != args.name]
        reg["gaps"].append({"name": args.name, "reason": args.gap,
                            "bug_ref": args.bug_ref, "added": now})
        save(reg)
        print(f"📋 detector-gap recorded: {args.name} — {args.gap}")
        print("   (self-heal surfaces open gaps so they get a detector later)")
        return

    if not args.cmd:
        sys.exit("--cmd is required (or use --gap to record a non-detectable bug)")

    if any(c["name"] == args.name for c in reg["checks"]) and not args.update:
        sys.exit(f"check {args.name!r} already exists — use --update to overwrite")

    # --- confirm the command runs before shipping it ---
    if not args.no_test:
        try:
            p = subprocess.run(["bash", "-lc", args.cmd], cwd=REPO,
                               capture_output=True, text=True, timeout=args.timeout)
            verdict = "HEALTHY (exit==ok)" if p.returncode == args.ok_exit else \
                      f"WOULD-FLAG (exit {p.returncode} != ok {args.ok_exit})"
            print(f"▶ test run: {verdict}")
            if p.returncode != args.ok_exit and (p.stdout or p.stderr):
                print("  output:", ((p.stdout or "") + (p.stderr or "")).strip()[-200:])
        except Exception as e:
            sys.exit(f"command failed to execute — fix it before registering: {e}")

    entry = {"name": args.name, "cmd": args.cmd, "ok_exit": args.ok_exit,
             "tier": args.tier, "timeout": args.timeout,
             "fail_detail": args.fail_detail or f"{args.name} regressed",
             "ok_detail": args.ok_detail or f"{args.name} ok",
             "bug_ref": args.bug_ref, "actions": args.action, "added": now}
    if args.heal:
        entry["heal_cmd"] = args.heal
    reg["checks"] = [c for c in reg["checks"] if c["name"] != args.name] + [entry]
    save(reg)
    print(f"✅ registered self-heal check '{args.name}' (tier={args.tier}) → {os.path.relpath(REGISTRY, REPO)}")
    print(f"   it runs every morning; trips → {'@Ant ping' if args.tier=='ant' else 'self-heal worklist'}.")


if __name__ == "__main__":
    main()
