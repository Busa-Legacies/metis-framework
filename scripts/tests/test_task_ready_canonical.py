from __future__ import annotations

import json
import os
import pathlib
import shutil
import stat
import subprocess
import tempfile
import textwrap
import unittest


REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE_SCRIPTS = REPO_ROOT / "scripts"


class TaskReadyCanonicalTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.repo = pathlib.Path(self._tmpdir.name)

        (self.repo / "docs/process/state").mkdir(parents=True, exist_ok=True)
        (self.repo / "docs/process").mkdir(parents=True, exist_ok=True)
        (self.repo / "scripts/lib").mkdir(parents=True, exist_ok=True)

        self._copy_script("task-ready.sh", executable=True)
        self._copy_script("task-ready-blockers.py", executable=True)
        self._copy_script("lib/task_state.py")
        (self.repo / "scripts/lib/__init__.py").write_text("", encoding="utf-8")

        self._write_file(
            "scripts/task-domain.py",
            "#!/usr/bin/env python3\nprint('unknown')\n",
            executable=True,
        )
        self._write_file(
            "scripts/task-verify.sh",
            "#!/usr/bin/env bash\necho 'verify stub'\nexit 1\n",
            executable=True,
        )

    def tearDown(self) -> None:
        self._tmpdir.cleanup()

    def _copy_script(self, relative_path: str, executable: bool = False) -> None:
        src = SOURCE_SCRIPTS / relative_path
        dst = self.repo / "scripts" / relative_path
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        if executable:
            dst.chmod(dst.stat().st_mode | stat.S_IXUSR)

    def _write_file(self, relative_path: str, content: str, executable: bool = False) -> None:
        path = self.repo / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        if executable:
            path.chmod(path.stat().st_mode | stat.S_IXUSR)

    def _write_tasks(self, tasks: list[dict]) -> None:
        payload = {"tasks": tasks}
        self._write_file(
            "docs/process/state/tasks.json",
            json.dumps(payload, indent=2) + "\n",
        )

    def _write_queue_projection(self, body: str) -> None:
        self._write_file("docs/process/task-queue.md", body)

    def _run_blockers(self, *args: str) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["REPO_ROOT"] = str(self.repo)
        return subprocess.run(
            ["python3", str(self.repo / "scripts/task-ready-blockers.py"), *args],
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )

    def _run_task_ready(self, query: str) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["REPO_ROOT"] = str(self.repo)
        return subprocess.run(
            ["bash", str(self.repo / "scripts/task-ready.sh"), query],
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )

    def test_blockers_cli_supports_one_and_two_argument_forms(self) -> None:
        self._write_tasks(
            [
                {
                    "taskId": "#100",
                    "title": "ready target",
                    "state": "queued",
                    "blockerOrNone": "blocked by #31 and #77",
                },
                {
                    "taskId": "#31",
                    "title": "prereq 31",
                    "state": "queued",
                    "blockerOrNone": "none",
                },
                {
                    "taskId": "#77",
                    "title": "prereq 77",
                    "state": "done",
                    "blockerOrNone": "none",
                },
            ]
        )
        self._write_queue_projection("projection content is ignored\n")

        one_arg = self._run_blockers("#100")
        two_arg = self._run_blockers("docs/process/task-queue.md", "#100")

        self.assertEqual(one_arg.returncode, 0)
        self.assertEqual(two_arg.returncode, 0)
        self.assertEqual(one_arg.stdout, "#31\n#77\n")
        self.assertEqual(two_arg.stdout, "#31\n#77\n")

    def test_task_ready_treats_done_prereq_as_satisfied_from_canonical_json(self) -> None:
        self._write_tasks(
            [
                {
                    "taskId": "#100",
                    "title": "ready target",
                    "state": "queued",
                    "blockerOrNone": "#31",
                },
                {
                    "taskId": "#31",
                    "title": "done prereq",
                    "state": "done",
                    "blockerOrNone": "none",
                },
            ]
        )
        self._write_queue_projection(
            textwrap.dedent(
                """\
                # Task Queue

                - #100 ready target [queued]
                  - blocked by #31
                - #31 done prereq [queued]
                """
            )
        )

        result = self._run_task_ready("#100")

        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        self.assertIn("✓ prerequisite #31 is done", result.stdout)
        self.assertIn("✓ READY — start working on '#100'", result.stdout)

    def test_task_ready_blocks_when_canonical_prereq_is_not_done(self) -> None:
        self._write_tasks(
            [
                {
                    "taskId": "#100",
                    "title": "blocked target",
                    "state": "queued",
                    "blockerOrNone": "#31",
                },
                {
                    "taskId": "#31",
                    "title": "open prereq",
                    "state": "queued",
                    "blockerOrNone": "none",
                },
            ]
        )
        self._write_queue_projection(
            textwrap.dedent(
                """\
                # Task Queue

                - #100 blocked target [queued]
                  - blocked by #31
                - #31 open prereq [done]
                """
            )
        )

        result = self._run_task_ready("#100")

        self.assertEqual(result.returncode, 1, msg=result.stdout + result.stderr)
        self.assertIn("✗ BLOCKED: prerequisite #31 is not done", result.stdout)
        self.assertIn("✗ NOT READY — 1 issue(s) must be resolved first", result.stdout)

    def test_no_short_id_misrouting_to_longer_id(self) -> None:
        self._write_tasks(
            [
                {
                    "taskId": "#313",
                    "title": "only long id exists",
                    "state": "queued",
                    "blockerOrNone": "none",
                }
            ]
        )
        self._write_queue_projection("projection content is ignored\n")

        blockers = self._run_blockers("#31")
        ready = self._run_task_ready("#31")

        self.assertEqual(blockers.returncode, 0)
        self.assertEqual(blockers.stdout, "")
        self.assertEqual(ready.returncode, 3, msg=ready.stdout + ready.stderr)
        self.assertIn("✗ UNKNOWN — verify manually before starting", ready.stdout)


if __name__ == "__main__":
    unittest.main()