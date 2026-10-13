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
import json
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
# Owner-specific scrub pairs (real IPs, partner and project names) live in the PRIVATE
# source repo, never here, so the public tool does not itself disclose what it hides.
# Format: [[regex, replacement], ...]. Missing file = refuse to publish (fail closed).
PRIVATE_SCRUBS = Path(os.environ.get("METIS_PRIVATE_SCRUBS")
                      or (SRC / "config/opensrc-private-scrubs.json"))


# Explicit file allowlist, also private (curation happens in the source repo). The
# manifest says where to LOOK; only listed, git-tracked files are copied. Fail closed.
ALLOWLIST = Path(os.environ.get("METIS_OPENSRC_ALLOWLIST")
                 or (SRC / "config/opensrc-allowlist.txt"))


def _load_allowlist():
    if not ALLOWLIST.exists():
        sys.exit(f"refusing to publish: allowlist not found at {ALLOWLIST}")
    return {ln.strip() for ln in ALLOWLIST.read_text().splitlines()
            if ln.strip() and not ln.lstrip().startswith("#")}


def _tracked_src():
    r = subprocess.run(["git", "-C", str(SRC), "ls-files"], capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"refusing to publish: cannot list tracked files in {SRC}")
    return set(r.stdout.splitlines())


def candidate_files():
    """Every tracked source file the manifest reaches, minus overlay."""
    tracked = _tracked_src()
    out = set()
    for _, rel in derived_items():
        if rel in tracked:
            out.add(rel)
        else:
            out |= {t for t in tracked if t.startswith(rel.rstrip("/") + "/")}
    return {f for f in out if f not in OVERLAY
            and not any(f == d or f.startswith(d + "/") for d in OVERLAY_DIRS)}


def _load_scrubs():
    if not PRIVATE_SCRUBS.exists():
        sys.exit(f"refusing to publish: private scrub rules not found at {PRIVATE_SCRUBS}")
    pairs = json.loads(PRIVATE_SCRUBS.read_text())
    return [(re.compile(rx), repl) for rx, repl in pairs]


# Safety-net scrub applied to DERIVED files after copy (never to OVERLAY).
# Generic rules here; owner-specific ones are appended from PRIVATE_SCRUBS at run time.
SCRUBS = [
    (re.compile(r"\btail[0-9a-f]{6,}\.ts\.net\b"), "<<TAILNET_DOMAIN>>"),  # any tailnet domain
    # Any Tailscale/CGNAT address (100.64.0.0/10) or macOS home path the private rules missed.
    (re.compile(r"\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b"), "<<TAILSCALE_IP>>"),
    (re.compile(r"/Users/[A-Za-z][\w.-]*"), "$HOME"),
    (re.compile(r"\bantfox\b"), "<<MACHINE_1_ID>>"),
    (re.compile(r"\bjarry\b"), "<<MACHINE_2_ID>>"),
    (re.compile(r"\babusa\b"), "<<MACHINE_2_USER>>"),
]
SCRUB_EXT = {".py", ".sh", ".json", ".md", ".ts", ".tsx", ".js", ".mjs", ".env", ".yml", ".yaml", ".template", ".html"}
# Extensionless config dotfiles have suffix "" and would skip the scrub entirely —
# .gitattributes shipped persona-named paths that way on the 0.1.0 refresh (CI caught it).
SCRUB_NAMES = {".gitattributes", ".prettierrc", ".gitignore", ".editorconfig"}


def derived_items():
    """The copy list from the manifest, minus overlay (derived)."""
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
    """No remaps currently (partner content was cut from the public line before launch)."""
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
    SCRUBS[:0] = _load_scrubs()  # owner-specific first: hostname rules must beat the bare-id rules
    allow = _load_allowlist()
    cands = candidate_files()
    held = sorted(cands - allow)
    copied = 0
    for rel in sorted(cands & allow):
        s, d = SRC / rel, DST / remap(rel)
        d.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(s, d)
        scrub_file(d)
        copied += 1
    for rel in sorted(allow - cands):
        print(f"  MISS {rel} (allowlisted but not reachable/tracked in source)")
    if held:
        print(f"held back {len(held)} unlisted file(s); review and add to {ALLOWLIST.name} to publish:")
        for rel in held:
            print(f"  HELD {rel}")
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
