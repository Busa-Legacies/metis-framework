#!/usr/bin/env python3
"""Mirror <<MACHINE_1_ID>>/<<MACHINE_2_ID>> 'how we work' config per ClaudeCode/mirror-manifest.json.

  mirror.py check            read-only drift report (exit 1 if drift). Wired into
                             the session-init hook so drift surfaces every session.
  mirror.py apply            heal symlinks + bin (idempotent, safe). Does NOT touch
                             settings.json unless --settings is passed.
  mirror.py apply --settings also deep-merge the canonical shared settings block
                             into ~/.claude/settings.json (preserves machine-local
                             keys). Run from /end + the weekly LaunchAgent, not every
                             session — so a local settings tweak is never clobbered
                             mid-session.

The repo is the single source of truth. Live config locations are symlinks into it
(commands, CLAUDE.md, hooks, ~/.local/bin guards) or a deep-merge of a canonical
shared file (settings.json). machine-local keys/files are never overwritten.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HOME = Path.home()
REPO = Path(os.environ.get("REPO_ROOT") or os.environ.get("METIS_HOME") or Path(__file__).resolve().parents[1])
MANIFEST = REPO / "ClaudeCode" / "mirror-manifest.json"
USER = (
    os.environ.get("USER")
    or subprocess.run(["id", "-un"], capture_output=True, text=True).stdout.strip()
)

DIM, RED, YEL, GRN, RST = "\033[2m", "\033[31m", "\033[33m", "\033[32m", "\033[0m"


def expand(p: str) -> Path:
    """~ -> live per-machine path; anything else -> repo-relative."""
    if p.startswith("~"):
        return Path(os.path.expanduser(p))
    return REPO / p


def load_manifest() -> dict:
    return json.loads(MANIFEST.read_text())


# ----- checks (read-only) ---------------------------------------------------


def check_symlinks(m) -> list:
    out = []
    for s in m.get("symlinks", []):
        link, target = expand(s["link"]), expand(s["target"])
        if not target.exists():
            out.append(("ERROR", f"repo source missing: {s['target']}"))
            continue
        if not link.is_symlink():
            kind = "real file" if link.exists() else "missing"
            out.append(("DRIFT", f"{s['link']} is {kind} (expected symlink -> {s['target']})"))
        elif Path(os.path.realpath(link)) != Path(os.path.realpath(target)):
            out.append(
                ("DRIFT", f"{s['link']} -> {os.path.realpath(link)} (expected {s['target']})")
            )
    return out


def _is_subset(a, b) -> bool:
    """Recursively check if 'a' is structurally contained within 'b'.

    Same-length lists: pairwise recursive comparison (items correspond positionally).
    Different-length lists: every a-item must appear verbatim in b (flat set check).
    Dicts: every key/value in a must exist in b with _is_subset value.
    Scalars: exact equality.
    """
    if isinstance(a, list) and isinstance(b, list):
        if len(a) == len(b):
            return all(_is_subset(ai, bi) for ai, bi in zip(a, b))
        b_strs = {json.dumps(x, sort_keys=True) for x in b}
        return all(json.dumps(x, sort_keys=True) in b_strs for x in a)
    if isinstance(a, dict) and isinstance(b, dict):
        return all(k in b and _is_subset(v, b[k]) for k, v in a.items())
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def _drift_direction(canonical_val, live_val) -> str:
    """Return 'CANONICAL_AHEAD', 'LOCAL_AHEAD', or 'DIVERGED' for a differing key."""
    if type(canonical_val) is not type(live_val):
        return "DIVERGED"
    if isinstance(canonical_val, (list, dict)):
        canon_in_live = _is_subset(canonical_val, live_val)
        live_in_canon = _is_subset(live_val, canonical_val)
        if canon_in_live and not live_in_canon:
            return "LOCAL_AHEAD"
        if live_in_canon and not canon_in_live:
            return "CANONICAL_AHEAD"
        return "DIVERGED"
    return "CANONICAL_AHEAD"


def check_settings(m) -> list:
    out = []
    for spec in m.get("merge", []):
        live_p, shared_p = expand(spec["file"]), expand(spec["shared"])
        shared = json.loads(shared_p.read_text())
        out.extend(validate_shared_settings(shared, spec["shared"]))
        live = json.loads(live_p.read_text()) if live_p.exists() else {}
        for k, v in shared.items():
            if k.startswith("_"):
                continue
            if live.get(k) != v:
                if k not in live:
                    direction = "CANONICAL_AHEAD"
                    hint = "heal: mirror.py apply --settings"
                else:
                    direction = _drift_direction(v, live[k])
                    if direction == "LOCAL_AHEAD":
                        hint = "local is ahead — update settings.shared.json instead of applying"
                    elif direction == "CANONICAL_AHEAD":
                        hint = "heal: mirror.py apply --settings"
                    else:
                        hint = "manual merge needed — values diverged in both directions"
                out.append(
                    (
                        "DRIFT",
                        f"settings.json key {k!r} differs [{direction}] ({hint})",
                    )
                )
    return out


def validate_shared_settings(shared: dict, source: str) -> list:
    """Catch corrupted canonical config before mirror can spread it.

    This protects against terminal-rendering artifacts being copied from a UI
    into the repo-backed settings file (for example an ESC-stripped ANSI tail
    like `claude-opus-4-8[0;1m`).  A bad canonical value is worse than live drift
    because `mirror.py apply --settings` would replicate it to both machines.

    NOTE: a properly-closed trailing `[1m]` is NOT corruption — it is the
    legitimate Claude Code 1M-context model alias (e.g. `claude-opus-4-8[1m]`,
    `claude-fable-5[1m]`).  We strip that known-good suffix before the ANSI-tail
    check so the guard stops false-flagging valid 1M-context model ids.
    """
    out = []
    model = shared.get("model")
    if model is not None:
        if not isinstance(model, str) or not model.strip():
            out.append(("ERROR", f"{source} has invalid model value {model!r}"))
        else:
            # Peel off the legitimate 1M-context suffix before the ANSI-tail scan.
            core = re.sub(r"\[1m\]$", "", model)
            if any(ord(ch) < 32 or ord(ch) == 127 for ch in model) or re.search(
                r"\[[0-9;]*m\]?$", core
            ):
                out.append(
                    (
                        "ERROR",
                        f"{source} model {model!r} looks like terminal formatting leaked into canonical settings",
                    )
                )
    return out


_TOML_TOP_LEVEL_RE = re.compile(r"^([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*(?:#.*)?$")


def _toml_top_level_values(path: Path, keys: list[str]) -> dict[str, str]:
    values = {}
    if not path.exists():
        return values
    for line in path.read_text().splitlines():
        stripped = line.strip()
        if stripped.startswith("["):
            break
        match = _TOML_TOP_LEVEL_RE.match(stripped)
        if match and match.group(1) in keys:
            values[match.group(1)] = match.group(2).strip()
    return values


def check_toml_merge(m) -> list:
    out = []
    for spec in m.get("tomlMerge", []):
        keys = spec.get("keys", [])
        live_p, shared_p = expand(spec["file"]), expand(spec["shared"])
        if not shared_p.exists():
            out.append(("ERROR", f"repo source missing: {spec['shared']}"))
            continue
        shared = _toml_top_level_values(shared_p, keys)
        live = _toml_top_level_values(live_p, keys)
        for key in keys:
            if key not in shared:
                out.append(("ERROR", f"{spec['shared']} missing canonical TOML key {key!r}"))
            elif live.get(key) != shared[key]:
                out.append(
                    (
                        "DRIFT",
                        f"{spec['file']} TOML key {key!r} differs [CANONICAL_AHEAD] (heal: mirror.py apply)",
                    )
                )
    return out


def check_codex_surface(m) -> list:
    if not m.get("codexSurface"):
        return []
    script = REPO / "scripts" / "sync-codex-surface.py"
    result = subprocess.run(
        [sys.executable, str(script), "--check"],
        cwd=REPO,
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        return []
    detail = (result.stdout or result.stderr).strip().replace("\n", " | ")
    return [("DRIFT", f"Codex command/skill surface drift ({detail})")]


def check_project_memory(m) -> list:
    out = []
    for c in m.get("checkOnly", []):
        if c.get("kind") != "project-memory-symlink":
            continue
        proj = HOME / ".claude" / "projects"
        hits = (
            [d / "memory" for d in proj.glob("*") if (d / "memory").exists()]
            if proj.exists()
            else []
        )
        repo_mem = REPO / "ClaudeCode" / "memory"
        ok = any(
            ln.is_symlink() and Path(os.path.realpath(ln)) == Path(os.path.realpath(repo_mem))
            for ln in hits
        )
        if not ok:
            out.append(
                (
                    "DRIFT",
                    "project memory dir is not a symlink into ClaudeCode/memory — run scripts/bootstrap-claude-memory.sh",
                )
            )
    return out


def check_model_host(m) -> list:
    """<<MACHINE_2_ID>>-only soft check: lanes should route to <<MACHINE_1_ID>>'s Ollama, not a paid model/localhost."""
    out = []
    mh = m.get("modelHost", {})
    if USER == mh.get("user"):
        return out  # this IS the model host (<<MACHINE_1_ID>>) — nothing to route
    ocfg = HOME / ".openclaw" / "openclaw.json"
    if not ocfg.exists():
        return out
    try:
        d = json.loads(ocfg.read_text())
    except Exception:
        return out
    lanes = d.get("agents", {}).get("list", []) if isinstance(d.get("agents"), dict) else []
    bad = [l.get("id") for l in lanes if l.get("model") and "ollama" not in str(l.get("model"))]
    if bad:
        out.append(
            (
                "WARN",
                f"lanes {bad} not routed to <<MACHINE_1_ID>>'s Ollama (modelHost rule) — expected ollama/* via OLLAMA_HOST={mh.get('tailscale')}",
            )
        )
    return out


def run_checks(m) -> list:
    return (
        check_symlinks(m)
        + check_settings(m)
        + check_toml_merge(m)
        + check_codex_surface(m)
        + check_project_memory(m)
        + check_model_host(m)
    )


# ----- apply (heal) ---------------------------------------------------------


def apply_symlinks(m) -> list:
    acted = []
    for s in m.get("symlinks", []):
        link, target = expand(s["link"]), expand(s["target"])
        if not target.exists():
            acted.append(("SKIP", f"repo source missing: {s['target']}"))
            continue
        if link.is_symlink() and Path(os.path.realpath(link)) == Path(os.path.realpath(target)):
            continue
        link.parent.mkdir(parents=True, exist_ok=True)
        if link.exists() and not link.is_symlink():
            bak = link.with_suffix(link.suffix + ".pre-mirror")
            link.replace(bak)
            acted.append(("BACKUP", f"{s['link']} -> {bak.name}"))
        elif link.is_symlink():
            link.unlink()
        os.symlink(target, link)
        if str(target).endswith(".sh"):
            os.chmod(target, 0o755)
        acted.append(("LINK", f"{s['link']} -> {s['target']}"))
    return acted


def apply_settings(m) -> list:
    acted = []
    for spec in m.get("merge", []):
        live_p, shared_p = expand(spec["file"]), expand(spec["shared"])
        shared = json.loads(shared_p.read_text())
        validation = validate_shared_settings(shared, spec["shared"])
        if validation:
            for level, msg in validation:
                acted.append((level, f"refusing settings merge: {msg}"))
            continue
        live = json.loads(live_p.read_text()) if live_p.exists() else {}
        changed = []
        for k, v in shared.items():
            if k.startswith("_"):
                continue
            if live.get(k) != v:
                live[k] = v
                changed.append(k)
        if changed:
            if live_p.exists():
                bak = live_p.with_suffix(".json.pre-mirror")
                bak.write_text(live_p.read_text())
            live_p.write_text(json.dumps(live, indent=4, ensure_ascii=False) + "\n")
            acted.append(("MERGE", f"{spec['file']} <- canonical keys: {', '.join(changed)}"))
    return acted


def apply_toml_merge(m) -> list:
    acted = []
    for spec in m.get("tomlMerge", []):
        keys = spec.get("keys", [])
        live_p, shared_p = expand(spec["file"]), expand(spec["shared"])
        if not shared_p.exists():
            acted.append(("SKIP", f"repo source missing: {spec['shared']}"))
            continue
        shared = _toml_top_level_values(shared_p, keys)
        missing_shared = [key for key in keys if key not in shared]
        if missing_shared:
            missing = ", ".join(repr(key) for key in missing_shared)
            acted.append(("SKIP", f"{spec['shared']} missing TOML keys: {missing}"))
            continue

        original = live_p.read_text() if live_p.exists() else ""
        lines = original.splitlines()
        changed = []
        seen = set()
        first_section = next(
            (i for i, line in enumerate(lines) if line.strip().startswith("[")), len(lines)
        )

        for i in range(first_section):
            match = _TOML_TOP_LEVEL_RE.match(lines[i].strip())
            if not match:
                continue
            key = match.group(1)
            if key not in shared:
                continue
            seen.add(key)
            replacement = f"{key} = {shared[key]}"
            if lines[i] != replacement:
                lines[i] = replacement
                changed.append(key)

        missing_live = [key for key in keys if key not in seen]
        if missing_live:
            insert = [f"{key} = {shared[key]}" for key in missing_live]
            if first_section == 0:
                lines = insert + [""] + lines
            else:
                lines[first_section:first_section] = insert + [""]
            changed.extend(missing_live)

        if changed:
            live_p.parent.mkdir(parents=True, exist_ok=True)
            if live_p.exists():
                bak = live_p.with_suffix(live_p.suffix + ".pre-mirror")
                bak.write_text(original)
            live_p.write_text("\n".join(lines).rstrip() + "\n")
            acted.append(
                ("MERGE", f"{spec['file']} <- canonical TOML keys: {', '.join(changed)}")
            )
    return acted


def apply_codex_surface(m) -> list:
    if not m.get("codexSurface"):
        return []
    script = REPO / "scripts" / "sync-codex-surface.py"
    result = subprocess.run(
        [sys.executable, str(script)],
        cwd=REPO,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        detail = (result.stdout or result.stderr).strip().replace("\n", " | ")
        return [("ERROR", f"Codex surface sync failed: {detail}")]
    first = result.stdout.strip().splitlines()[0] if result.stdout.strip() else "done"
    return [("SYNC", first)]


# ----- cli ------------------------------------------------------------------


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = ap.add_subparsers(dest="cmd", required=True)
    ap_check = sub.add_parser("check")
    ap_check.add_argument("--quiet", action="store_true", help="print only on drift")
    ap_apply = sub.add_parser("apply")
    ap_apply.add_argument(
        "--settings", action="store_true", help="also deep-merge canonical shared settings"
    )
    args = ap.parse_args()
    args.quiet = getattr(args, "quiet", False)

    m = load_manifest()
    machine = "<<MACHINE_1_ID>>" if USER == "Ant" else ("<<MACHINE_2_ID>>" if USER == "<<MACHINE_2_USER>>" else USER)

    if args.cmd == "check":
        issues = run_checks(m)
        if not issues:
            if not args.quiet:
                print(f"{GRN}✓ mirror: {machine} in sync with canonical{RST}")
            return 0
        errs = [i for i in issues if i[0] in ("DRIFT", "ERROR")]
        print(
            f"{YEL}⚠ mirror drift on {machine} ({len(issues)} item(s)) — heal: python3 scripts/mirror.py apply --settings{RST}"
        )
        for level, msg in issues:
            col = RED if level in ("ERROR", "DRIFT") else YEL
            print(f"  {col}[{level}]{RST} {msg}")
        return 1 if errs else 0

    if args.cmd == "apply":
        acted = apply_codex_surface(m) + apply_symlinks(m) + apply_toml_merge(m)
        if args.settings:
            acted += apply_settings(m)
        if not acted:
            print(f"{GRN}✓ mirror apply: nothing to do — {machine} already in sync{RST}")
        else:
            print(f"{GRN}✓ mirror apply on {machine}:{RST}")
            for level, msg in acted:
                print(f"  [{level}] {msg}")
        if any(level == "ERROR" for level, _ in acted):
            return 1
        if not args.settings:
            print(
                f"{DIM}  (settings.json not touched — re-run with --settings to merge canonical settings){RST}"
            )
        return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"{RED}ERROR: {exc}{RST}", file=sys.stderr)
        sys.exit(2)
