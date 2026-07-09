#!/usr/bin/env python3
"""publish.py — Model B publish pipeline: refresh metis-core FROM metis-os.

metis-os is the canonical AUTHOR of the framework (Phase 1). This script makes the
publish reproducible so a refresh never re-contaminates the clean core:

  1. DERIVED files (the bulk: most scripts/docs/hooks/frameworks) are
     re-copied from metis-os via the manifest.
  2. OVERLAY files (metis-core OWNS these — the parameterized seam + product files)
     are NEVER overwritten by a copy. Upstream edits to them are ported by hand.
  3. SCRUB transforms run over derived files as a safety net (strip any IPs / home
     paths / hardcoded channel-id defaults that slipped in).

Run from the repo root:  python3 build/publish.py            # refresh + report diff
                         python3 build/publish.py --commit   # also commit + push

The result is byte-reproducible: same metis-os state -> same metis-core tree.
"""
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import manifest as M  # noqa: E402

SRC = M.SRC                       # ~/metis-os
DST = Path(__file__).resolve().parents[1]  # this repo (~/metis-core)

# Files metis-core OWNS — authored/parameterized here, NOT derived from metis-os.
# A publish leaves these untouched; port upstream changes to them deliberately.
OVERLAY = {
    "CLAUDE.md", "README.md", "SPLIT.md", "LICENSE", "VERSION", "CHANGELOG.md",
    ".gitignore",
    "config/infrastructure.json",
    "scripts/lib/infra_config.py",
    "scripts/free-work.py", "scripts/queue-runner.py", "scripts/task-domain.py",
    "ClaudeCode/bin/claude-machine-identity.sh",
    "ClaudeCode/hooks/hook-session-init.sh",
    "ClaudeCode/settings.shared.json", "ClaudeCode/mirror-manifest.json",
    "scripts/lib/network.env", "scripts/lib/network.py",
    "docs/PRODUCTIZATION.md",
    "docs/harness-primitives.md",
}

# Whole directories metis-core OWNS — publish never copies into them (CI, issue
# templates, ownership are product config, not derived from metis-os).
OVERLAY_DIRS = {".github"}

# Safety-net scrub applied to DERIVED files after copy (never to OVERLAY).
SCRUBS = [
    (re.compile(r"100\.82\.81\.93"), "<<MACHINE_1_TAILSCALE_IP>>"),
    (re.compile(r"100\.80\.166\.77"), "<<MACHINE_2_TAILSCALE_IP>>"),
    (re.compile(r"antfox-macbook"), "<<MACHINE_1_HOSTNAME>>"),
    (re.compile(r"anthonys-macbook-pro"), "<<MACHINE_2_HOSTNAME>>"),
    (re.compile(r"/Users/Ant/metis-os"), "${METIS_HOME}"),
    (re.compile(r"/Users/abusa/metis-os"), "${METIS_HOME}"),
    (re.compile(r"/Users/Ant"), "$HOME"),
    (re.compile(r"/Users/abusa"), "$HOME"),
    (re.compile(r":-1489674856579600455"), ""),
    # Machine-local WORKSPACE dir (board projection + working-context + daily logs).
    # In metis-os this dir is persona-named (Hearth/... , legacy Jay/...). A path-use
    # of it must become a neutral, portable 'workspace/' so a fresh consumer's cold-start
    # loop writes to a real resolvable dir — NOT an unresolved <<MACHINE_1_ID>> placeholder
    # that render-tier1-state.py would create as a literal directory. This MUST run before
    # the bare-persona rule below so only the PATH form is neutralized; prose mentions of
    # the machine still scrub to the id placeholder. (#434 path-resolution sweep.)
    (re.compile(r"\b(?:Hearth|HEARTH|Jay|JAY)/(?=state|memory|lanes|AGENTS\.md|SOUL\.md|\.gitignore|HANDOFF)"), "workspace/"),
    # Machine persona names → org-neutral id placeholders. The framework ships LANE
    # role names (smith/scout/warden/...) as real vocabulary, but MACHINE names are
    # org-specific topology → placeholders resolved from config/infrastructure.json.
    # Both the rebranded (Hearth/Outpost) and legacy (Jay/Jarry) names are scrubbed so
    # no host persona leaks regardless of source vintage. (#121 launch.)
    (re.compile(r"\b(?:Hearth|HEARTH|Jay|JAY)\b"), "<<MACHINE_1_ID>>"),
    (re.compile(r"\b(?:Outpost|OUTPOST|Jarry|JARRY)\b"), "<<MACHINE_2_ID>>"),
    # Bare lowercase machine-id / user personas used in CODE (set literals, defaults).
    # The capitalized rule above and the CI leak-guard both missed these. Must run
    # AFTER the antfox-macbook hostname rule so the hostname maps to its own placeholder. (#434)
    (re.compile(r"\bantfox\b"), "<<MACHINE_1_ID>>"),
    (re.compile(r"\bjarry\b"), "<<MACHINE_2_ID>>"),
    (re.compile(r"\babusa\b"), "<<MACHINE_2_USER>>"),
    # Org-specific project slugs used as examples in derived skill docs — neutralize
    # so the public framework ships generic illustrations, not Ant's real projects.
    # (Source stays accurate in metis-os; this is the publish seam. #121 launch.)
    (re.compile(r"navore-lfpp-grant-tracker"), "example-grant-tracker"),
    (re.compile(r"navore-lfpp"), "example-grant"),
    (re.compile(r"navore-brief"), "partner-brief"),
    (re.compile(r"gap/navore/"), "gap/example/"),
    (re.compile(r"\bnavore\b"), "example"),
    (re.compile(r"\bNavore\b"), "Example"),
]
SCRUB_EXT = {".py", ".sh", ".json", ".md", ".ts", ".tsx", ".js", ".mjs", ".env", ".yml", ".yaml", ".template", ".html"}
# Extensionless config dotfiles have suffix "" and would skip the scrub entirely —
# .gitattributes shipped persona-named paths that way on the 0.1.0 refresh (CI caught it).
SCRUB_NAMES = {".gitattributes", ".prettierrc", ".gitignore", ".editorconfig"}


def derived_items():
    """The copy list from the manifest, minus overlay, plus navore/ (derived)."""
    items = []
    items += [("dir", d) for d in M.CORE_DIRS]
    items += [("file", f) for f in M.CORE_FILES]
    items += [("file", f"scripts/{s}") for s in M.CORE_SCRIPTS]
    items += [("file", f"scripts/{s}") for s in M.PARAM_SCRIPTS]
    items += [("file", f"docs/process/{d}") for d in M.CORE_PROCESS_DOCS]
    if (SRC / "docs/process/decisions").exists():
        items.append(("dir", "docs/process/decisions"))
    for f in ["projects/forge3d/lib", "projects/forge3d/scripts", "projects/forge3d/README.md"]:
        items.append(("any", f))
    return items


def remap(rel):
    """No remaps currently. (navore/ was cut from the public framework 2026-06-13,
    #121 — business IP stays private, scaffold moved to the Navore-Ops repo.)"""
    return rel


def scrub_file(p: Path):
    if p.suffix not in SCRUB_EXT and p.name not in SCRUB_NAMES:
        return
    try:
        txt = p.read_text()
    except (UnicodeDecodeError, OSError):
        return
    new = txt
    for rx, repl in SCRUBS:
        new = rx.sub(repl, new)
    if new != txt:
        p.write_text(new)


def publish():
    copied = 0
    for _, rel in derived_items():
        if rel in OVERLAY or any(rel == d or rel.startswith(d + "/") for d in OVERLAY_DIRS):
            continue
        s = SRC / rel
        if not s.exists():
            print(f"  MISS {rel}")
            continue
        d = DST / remap(rel)
        d.parent.mkdir(parents=True, exist_ok=True)
        if s.is_dir():
            shutil.copytree(
                s, d, dirs_exist_ok=True, ignore_dangling_symlinks=True,
                ignore=shutil.ignore_patterns(*M.IGNORE_PATTERNS if hasattr(M, "IGNORE_PATTERNS") else (
                    "__pycache__", "*.pyc", ".DS_Store", "node_modules", ".next",
                    "dist", "build", ".turbo", "*.log", "playwright-report", ".venv",
                    "venv", "*.db", "*.db-wal", "*.db-shm", ".env", "out", "coverage",
                    ".cache", "dist-app", "release")),
            )
            for f in d.rglob("*"):
                if f.is_file():
                    scrub_file(f)
        else:
            shutil.copy2(s, d)
            scrub_file(d)
        copied += 1
    print(f"published {copied} derived path(s)")
    # Overlay files can live INSIDE a wholesale-copied dir (e.g. scripts/lib/,
    # ClaudeCode/bin/), so a dir copy may clobber them. Re-assert every overlay
    # path from git HEAD as the final step — git is the source of truth for what
    # metis-core OWNS. Anything not yet committed stays as authored on disk.
    tracked = [f for f in OVERLAY if (DST / f).exists()]
    if tracked:
        subprocess.run(["git", "-C", str(DST), "checkout", "HEAD", "--", *tracked],
                       capture_output=True, text=True)
    print(f"re-asserted {len(tracked)} overlay file(s) from git")


def git(*args):
    return subprocess.run(["git", "-C", str(DST), *args], capture_output=True, text=True)


def main():
    publish()
    status = git("status", "--short").stdout.strip()
    if not status:
        print("no changes — metis-core already in sync with metis-os core")
        return
    print("changed:\n" + status)
    if "--commit" in sys.argv:
        git("add", "-A")
        git("commit", "-m", "publish: refresh core from metis-os")
        push = git("push", "origin", "main")
        print("pushed" if push.returncode == 0 else f"push failed:\n{push.stderr}")


if __name__ == "__main__":
    main()
