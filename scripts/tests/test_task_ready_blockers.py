from __future__ import annotations

import importlib.util
import pathlib
import unittest


def _load_module():
    script_path = pathlib.Path(__file__).resolve().parents[1] / "task-ready-blockers.py"
    spec = importlib.util.spec_from_file_location("task_ready_blockers", script_path)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


task_ready_blockers = _load_module()


class ParseArgsTests(unittest.TestCase):
    def test_single_argument_id_passthrough(self) -> None:
        self.assertEqual(task_ready_blockers._parse_args(["#349"]), ("plain", "#349"))

    def test_multiword_title_is_joined(self) -> None:
        self.assertEqual(
            task_ready_blockers._parse_args(["Exact", "Multi", "Word", "Title"]),
            ("plain", "Exact Multi Word Title"),
        )

    def test_mode_with_multiword_title_is_joined(self) -> None:
        self.assertEqual(
            task_ready_blockers._parse_args(["--status", "Exact", "Multi", "Word", "Title"]),
            ("--status", "Exact Multi Word Title"),
        )

    def test_queue_file_prefix_is_ignored_for_multiword_title(self) -> None:
        self.assertEqual(
            task_ready_blockers._parse_args(
                ["docs/process/task-queue.md", "Exact", "Multi", "Word", "Title"]
            ),
            ("plain", "Exact Multi Word Title"),
        )

    def test_mode_and_queue_file_prefix_are_both_handled(self) -> None:
        self.assertEqual(
            task_ready_blockers._parse_args(
                ["--pending-only", "docs/process/task-queue.md", "Exact", "Multi", "Word", "Title"]
            ),
            ("--pending-only", "Exact Multi Word Title"),
        )


if __name__ == "__main__":
    unittest.main()