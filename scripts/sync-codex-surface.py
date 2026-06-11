#!/usr/bin/env python3
"""Sync Claude Code workflows into Codex-discoverable repo surfaces.

Canonical workflow bodies live in ClaudeCode/skills/ and, for legacy commands,
ClaudeCode/commands/. Codex discovers reusable skills from .agents/skills, while
deprecated custom slash prompts still load from ~/.codex/prompts. This script:

- populates .agents/skills with symlinks to each ClaudeCode skill
- creates .codex/prompts/<slug>.md adapters for every Claude skill/command
- preserves hand-written Codex prompt adapters unless --force is supplied
- prunes only generated prompt adapters for removed source workflows
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CLAUDE_SKILLS = ROOT / "ClaudeCode" / "skills"
CLAUDE_COMMANDS = ROOT / "ClaudeCode" / "commands"
CODEX_PROMPTS = ROOT / ".codex" / "prompts"
AGENTS_SKILLS = ROOT / ".agents" / "skills"
MARKER = "<!-- GENERATED: scripts/sync-codex-surface.py -->"


@dataclass(frozen=True)
class Workflow:
    slug: str
    source_kind: str
    source_rel: str
    description: str


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def read_description(path: Path) -> str:
    text = path.read_text()
    fm = re.match(r"^---\n(.*?)\n---\n", text, flags=re.S)
    if fm:
        for line in fm.group(1).splitlines():
            if line.startswith("description:"):
                value = line.split(":", 1)[1].strip()
                return value.strip("\"'")
    for line in text.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            return stripped
    return f"Run the {path.stem} workflow."


def workflows() -> dict[str, Workflow]:
    out: dict[str, Workflow] = {}
    for skill in sorted(CLAUDE_SKILLS.glob("*/SKILL.md")):
        slug = skill.parent.name
        out[slug] = Workflow(
            slug=slug,
            source_kind="skill",
            source_rel=rel(skill),
            description=read_description(skill),
        )
    for command in sorted(CLAUDE_COMMANDS.glob("*.md")):
        slug = command.stem
        if slug in out:
            continue
        out[slug] = Workflow(
            slug=slug,
            source_kind="legacy command",
            source_rel=rel(command),
            description=read_description(command),
        )
    return dict(sorted(out.items()))


def prompt_body(w: Workflow) -> str:
    return f"""---
description: {json.dumps(w.description)}
argument-hint: "$ARGUMENTS"
---

{MARKER}

# {w.slug}

Run the Metis OS `{w.slug}` workflow from the canonical Claude Code {w.source_kind}.

Authoritative source: `{w.source_rel}`.

Input arguments from the slash prompt: `$ARGUMENTS`

Codex instructions:
- Read the authoritative source before acting.
- Load any bundled reference files from the same skill directory only when the workflow calls for them.
- Apply Codex-specific runtime policy from `docs/process/codex-launch-policy.md`.
- Claim governed work as `codex` when the workflow needs a lease.
- Follow `AGENTS.md` and `ClaudeCode/codex/instructions.md` for shared doctrine, verification, and sign-off.

Now execute the workflow described in `{w.source_rel}` using `$ARGUMENTS` as the user's request.
"""


def ensure_symlink(path: Path, target: Path, check: bool, actions: list[str], errors: list[str]) -> None:
    desired = os.path.relpath(target, path.parent)
    if path.is_symlink():
        current = os.readlink(path)
        if current == desired:
            return
        if check:
            errors.append(f"{rel(path)} -> {current} (expected {desired})")
            return
        path.unlink()
    elif path.exists():
        if check:
            errors.append(f"{rel(path)} exists but is not a symlink")
            return
        backup = path.with_name(path.name + ".pre-codex-sync")
        if backup.exists():
            if backup.is_dir() and not backup.is_symlink():
                shutil.rmtree(backup)
            else:
                backup.unlink()
        path.rename(backup)
        actions.append(f"BACKUP {rel(path)} -> {rel(backup)}")
    elif check:
        errors.append(f"{rel(path)} missing")
        return

    path.parent.mkdir(parents=True, exist_ok=True)
    path.symlink_to(desired)
    actions.append(f"LINK {rel(path)} -> {desired}")


def ensure_repo_skill_links(
    expected: dict[str, Workflow], check: bool, actions: list[str], errors: list[str]
) -> None:
    skill_slugs = {slug for slug, workflow in expected.items() if workflow.source_kind == "skill"}

    if AGENTS_SKILLS.is_symlink():
        if check:
            errors.append(f"{rel(AGENTS_SKILLS)} is a root symlink; expected a directory")
            return
        AGENTS_SKILLS.unlink()
        actions.append(f"UNLINK {rel(AGENTS_SKILLS)} root symlink")
    elif AGENTS_SKILLS.exists() and not AGENTS_SKILLS.is_dir():
        if check:
            errors.append(f"{rel(AGENTS_SKILLS)} exists but is not a directory")
            return
        backup = AGENTS_SKILLS.with_name(AGENTS_SKILLS.name + ".pre-codex-sync")
        AGENTS_SKILLS.rename(backup)
        actions.append(f"BACKUP {rel(AGENTS_SKILLS)} -> {rel(backup)}")

    if check and not AGENTS_SKILLS.exists():
        errors.append(f"{rel(AGENTS_SKILLS)} missing")
        return
    AGENTS_SKILLS.mkdir(parents=True, exist_ok=True)

    for slug in sorted(skill_slugs):
        ensure_symlink(AGENTS_SKILLS / slug, CLAUDE_SKILLS / slug, check, actions, errors)

    for child in sorted(AGENTS_SKILLS.iterdir()):
        if child.name in skill_slugs or child.name == ".system":
            continue
        if child.is_symlink():
            if check:
                errors.append(f"{rel(child)} has no source skill")
                continue
            child.unlink()
            actions.append(f"PRUNE {rel(child)}")


def sync_prompts(expected: dict[str, Workflow], check: bool, force: bool, actions: list[str], errors: list[str]) -> None:
    CODEX_PROMPTS.mkdir(parents=True, exist_ok=True)
    for slug, workflow in expected.items():
        path = CODEX_PROMPTS / f"{slug}.md"
        desired = prompt_body(workflow)
        if path.exists():
            current = path.read_text()
            if MARKER not in current and not force:
                continue
            if current == desired:
                continue
            if check:
                errors.append(f"{rel(path)} generated adapter is stale")
                continue
        elif check:
            errors.append(f"{rel(path)} missing")
            continue
        path.write_text(desired)
        actions.append(f"WRITE {rel(path)}")

    expected_names = {f"{slug}.md" for slug in expected}
    for path in sorted(CODEX_PROMPTS.glob("*.md")):
        if path.name in expected_names:
            continue
        if MARKER not in path.read_text():
            continue
        if check:
            errors.append(f"{rel(path)} generated adapter has no source workflow")
            continue
        path.unlink()
        actions.append(f"PRUNE {rel(path)}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="report drift without writing")
    ap.add_argument("--force", action="store_true", help="regenerate hand-written prompt adapters too")
    args = ap.parse_args()

    expected = workflows()
    actions: list[str] = []
    errors: list[str] = []

    ensure_repo_skill_links(expected, args.check, actions, errors)
    sync_prompts(expected, args.check, args.force, actions, errors)

    if errors:
        print("codex surface drift:")
        for error in errors:
            print(f"  - {error}")
        return 1

    if args.check:
        print(f"codex surface ok ({len(expected)} workflows)")
    elif actions:
        print(f"codex surface synced ({len(expected)} workflows):")
        for action in actions:
            print(f"  {action}")
    else:
        print(f"codex surface already synced ({len(expected)} workflows)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
