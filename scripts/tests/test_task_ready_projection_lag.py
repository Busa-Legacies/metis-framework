#!/usr/bin/env python3
"""Regression test: task-ready must trust canonical tasks.json over stale markdown.

Scenario:
- task A is blocked by task B
- stale markdown still says task B is queued
- canonical tasks.json says task B is done

Expected:
- scripts/task-ready.sh treats task B as satisfied and returns READY
"""

from __future__ import annotations

import json
import os
import stat
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


SOURCE_REPO = Path(__file__).resolve().parents[2]
SOURCE_TASK_READY = SOURCE_REPO / "scripts" / "task-ready.sh"
SOURCE_TASK_READY_BLOCKERS = SOURCE_REPO / "scripts" / "task-ready-blockers.py"
SOURCE_TASK_STATE = SOURCE_REPO / "scripts" / "lib" / "task_state.py"


class TaskReadyProjectionLagTest(unittest.TestCase):
    maxDiff = None

    def test_done_prereq_in_json_satisfies_gate_even_if_markdown_lags(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            repo = Path(tmpdir)

            self._write(
                repo / "docs/process/state/tasks.json",
                json.dumps(
                    {
                        "tasks": [
                            {
                                "taskId": "#349",
                                "title": "task-ready-prereq-from-canonical",
                                "state": "queued",
                                "blockerOrNone": "Blocked by #348",
                            },
                            {
                                "taskId": "#348",
                                "title": "canonical-resolver-now-exists",
                                "state": "done",
                                "blockerOrNone": "none",
                            },
                        ]
                    },
                    indent=2,
                )
                + "\n",
            )

            # Deliberately stale projection: the dependency still appears queued here.
            self._write(
                repo / "task-queue.md",
                textwrap.dedent(
                    """\
                    ## Queue

                    - [ ] #349 task-ready-prereq-from-canonical
                      - blocked by: #348
                    - [ ] #348 canonical-resolver-now-exists
                    """
                ),
            )

            self._write_task_state_wrapper(repo)
            self._write_task_ready_blockers_wrapper(repo)
            self._write(
                repo / "scripts/task-domain.py",
                "#!/usr/bin/env python3\nprint('unknown')\n",
                executable=True,
            )
            self._write(
                repo / "scripts/task-verify.sh",
                "#!/usr/bin/env bash\nexit 1\n",
                executable=True,
            )

            result = subprocess.run(
                ["bash", str(SOURCE_TASK_READY), "#349"],
                capture_output=True,
                text=True,
                env={**os.environ, "REPO_ROOT": str(repo)},
                check=False,
            )

            combined = result.stdout + result.stderr
            self.assertEqual(
                result.returncode,
                0,
                msg=f"expected READY exit from task-ready.sh\n{combined}",
            )
            self.assertIn("✓ prerequisite #348 is done", combined)
            self.assertIn("✓ READY — start working on '#349'", combined)
            self.assertNotIn("✗ BLOCKED: prerequisite #348 is not done", combined)

    def _write_task_state_wrapper(self, repo: Path) -> None:
        wrapper = textwrap.dedent(
            f"""\
            from importlib.util import module_from_spec, spec_from_file_location

            _SPEC = spec_from_file_location("_source_task_state", {str(SOURCE_TASK_STATE)!r})
            _MOD = module_from_spec(_SPEC)
            assert _SPEC is not None and _SPEC.loader is not None
            _SPEC.loader.exec_module(_MOD)

            resolve = _MOD.resolve
            state = _MOD.state
            is_done = _MOD.is_done
            doneWhen = _MOD.doneWhen
            fields = _MOD.fields
            blockers = _MOD.blockers
            """
        )
        self._write(repo / "scripts/lib/task_state.py", wrapper)

    def _write_task_ready_blockers_wrapper(self, repo: Path) -> None:
        wrapper = textwrap.dedent(
            f"""\
            #!/usr/bin/env python3
            import runpy

            runpy.run_path({str(SOURCE_TASK_READY_BLOCKERS)!r}, run_name="__main__")
            """
        )
        self._write(repo / "scripts/task-ready-blockers.py", wrapper, executable=True)

    def _write(self, path: Path, content: str, executable: bool = False) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        if executable:
            path.chmod(path.stat().st_mode | stat.S_IXUSR)


if __name__ == "__main__":
    unittest.main()