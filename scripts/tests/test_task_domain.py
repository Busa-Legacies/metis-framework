from __future__ import annotations

import importlib.util
import pathlib
import sys

import pytest


REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / "scripts"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from lib import task_state  # noqa: E402


def _load_task_domain_module():
    module_path = SCRIPTS_DIR / "task-domain.py"
    spec = importlib.util.spec_from_file_location("task_domain", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def task_domain():
    return _load_task_domain_module()


def test_bare_id_uses_its_own_canonical_record(task_domain, monkeypatch):
    tasks = [
        {
            "taskId": "#1313",
            "title": "Substring neighbour",
            "project": "Dashboard",
            "area": "Example Market",
            "domain": "career",
        },
        {
            "taskId": "#313",
            "title": "Target task",
            "project": "Personal & Life",
            "area": "Personal Site",
            "domain": "presence",
        },
    ]

    monkeypatch.setattr(task_state, "snapshot", lambda: tasks)

    assert task_domain.get_section("#313") == "Personal Site"
    assert task_domain.get_concern("#313") == "personal"
    assert task_domain.get_domain("#313") == "presence"


def test_unresolved_label_falls_back_to_legacy_heuristic(task_domain, monkeypatch):
    monkeypatch.setattr(task_state, "snapshot", lambda: [])

    label = "Automation cleanup sweep"

    assert task_domain.get_section(label) == "Automation"
    assert task_domain.get_concern(label) == "infrastructure"
    assert task_domain.get_domain(label) == "systems"