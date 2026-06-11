"""Unit tests for scripts/lib/progress.py (#221)."""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from lib import progress as P  # noqa: E402

PROJECTS = json.loads(
    (pathlib.Path(__file__).resolve().parents[2] / "docs/process/state/projects.json").read_text()
)["projects"]


def by_slug(slug):
    return next(p for p in PROJECTS if p["slug"] == slug)


def approx(a, b, tol=0.01):
    return a is not None and abs(a - b) <= tol


def test_weighted_progress_demo_numbers():
    # trading-backend: done weights 1+3+1+1=6 over total 1+3+1+1+3=9 → 0.667
    prog, shipped, total = P.project_progress(by_slug("trading-backend"))
    assert approx(prog, 6 / 9), prog
    assert (shipped, total) == (4, 5)

    # command-center: done 3+2+1=6 over 3+2+1+3+2=11 → 0.545
    prog, shipped, total = P.project_progress(by_slug("command-center"))
    assert approx(prog, 6 / 11), prog
    assert (shipped, total) == (3, 5)

    # consulting: M2 done(1) + M1 active fill .6 (1×.6) + M3 active .5 (1×.5) = 2.1 over 1+1+1+3=6 → 0.35
    prog, shipped, total = P.project_progress(by_slug("consulting"))
    assert approx(prog, 2.1 / 6), prog
    assert (shipped, total) == (1, 4)


def test_partial_credit_never_reads_as_done():
    # consulting has 4 milestones, only 1 shipped, despite 35% fill
    prog, shipped, total = P.project_progress(by_slug("consulting"))
    assert shipped < total
    assert prog < 1.0


def test_evergreen_excluded():
    prog, _, _ = P.project_progress(by_slug("ops"))
    assert prog is None
    prog, _, _ = P.project_progress(by_slug("personal"))
    assert prog is None


def test_goal_rollup_excludes_paused_and_evergreen():
    # G4: trading-backend active (0.667); trading-bot & finances-panel paused → excluded
    g4 = P.goal_rollup(PROJECTS, "G4")
    assert approx(g4, 6 / 9), g4


def test_priority_weighted_rollup():
    # synthetic: one P1 at 1.0, one P3 at 0.0 → (3×1 + 1×0)/(3+1) = 0.75
    fake = [
        {"slug": "a", "goal": "GX", "priority": "P1", "status": "active",
         "milestones": [{"status": "done", "weight": 1}]},
        {"slug": "b", "goal": "GX", "priority": "P3", "status": "active",
         "milestones": [{"status": "todo", "weight": 1, "fill": 0}]},
    ]
    assert approx(P.goal_rollup(fake, "GX"), 0.75)


def test_classify_decision_for_blocked_current():
    # trading-backend: 4 done then M4 blocked → decision bucket
    assert P.classify(by_slug("trading-backend")) == "decision"
    # ops evergreen
    assert P.classify(by_slug("ops")) == "evergreen"


def test_bar_render():
    assert P.bar(0.0) == "░" * 10
    assert P.bar(1.0) == "█" * 10
    assert P.bar(None) == "—" * 10


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for fn in fns:
        try:
            fn()
            print(f"  ok  {fn.__name__}")
            passed += 1
        except AssertionError as e:
            print(f"FAIL  {fn.__name__}: {e}")
        except Exception as e:
            print(f"ERR   {fn.__name__}: {e!r}")
    print(f"\n{passed}/{len(fns)} passed")
    sys.exit(0 if passed == len(fns) else 1)
