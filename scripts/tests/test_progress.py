"""Unit tests for scripts/lib/progress.py (#221).

These assert the CONTRACT with synthetic fixtures, not arithmetic against the live
docs/process/state/projects.json (#4605). The original suite did the latter — it hardcoded
"trading-backend is 6/9", "ops has no progress", "G4 rolls up to 6/9" — and every one of those
went stale the moment someone edited a milestone, which is exactly what happened: a blocked
milestone gained fill: 0.5, evergreen catchments were seeded with milestones, and G4 grew a
second project. Three assertions failed while the library itself was correct.

A suite that reads production state can only ever be as stable as that state. The numbers live in
fixtures here; the live file is exercised separately, for invariants that must hold no matter what
anyone edits.
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from lib import progress as P  # noqa: E402

PROJECTS = json.loads(
    (pathlib.Path(__file__).resolve().parents[2] / "docs/process/state/projects.json").read_text()
)["projects"]


def approx(a, b, tol=0.01):
    return a is not None and abs(a - b) <= tol


def proj(slug, **kw):
    """A minimal project. Callers override only what the assertion is about."""
    base = {"slug": slug, "goal": "GX", "priority": "P2", "status": "active", "milestones": []}
    base.update(kw)
    return base


def test_weighted_progress_is_weight_times_credit():
    # done contributes its full weight; anything else contributes weight × fill
    p = proj("w", milestones=[
        {"status": "done", "weight": 1},
        {"status": "done", "weight": 3},
        {"status": "todo", "weight": 3, "fill": 0.0},
    ])
    prog, shipped, total = P.project_progress(p)
    assert approx(prog, 4 / 7), prog
    assert (shipped, total) == (2, 3)


def test_partial_fill_earns_partial_credit():
    p = proj("f", milestones=[
        {"status": "done", "weight": 1},
        {"status": "active", "weight": 1, "fill": 0.6},
        {"status": "blocked", "weight": 2, "fill": 0.5},
    ])
    prog, shipped, total = P.project_progress(p)
    assert approx(prog, (1 + 0.6 + 1.0) / 4), prog
    assert (shipped, total) == (1, 3)


def test_shipped_count_is_the_honesty_floor_not_the_percentage():
    """What the contract actually guarantees, which is narrower than it first reads.

    "Partial credit can never make an unfinished milestone read as done" is delivered by the
    X/N shipped annotation rendered beside the bar, NOT by clamping the percentage: a milestone
    at fill 1.0 contributes its full weight, so a project CAN show 100% with milestones still
    unshipped. `going-on` in the live file is exactly that today (M2 active at fill 1.0), and an
    invariant test that assumed the stronger reading flagged it as corruption when it is
    contract-conformant. The count is what must never lie.
    """
    p = proj("h", milestones=[
        {"status": "active", "weight": 1, "fill": 0.99},
        {"status": "todo", "weight": 1, "fill": 0.99},
    ])
    prog, shipped, total = P.project_progress(p)
    assert prog < 1.0 and shipped == 0 and total == 2

    full = proj("full", milestones=[
        {"status": "done", "weight": 1},
        {"status": "active", "weight": 1, "fill": 1.0},
    ])
    prog, shipped, total = P.project_progress(full)
    assert approx(prog, 1.0), prog          # the bar may read 100%...
    assert (shipped, total) == (1, 2)       # ...but the annotation still says 1 of 2


def test_unseeded_project_has_no_progress():
    prog, shipped, total = P.project_progress(proj("empty", milestones=[]))
    assert prog is None and (shipped, total) == (0, 0)
    # zero total weight is the same "cannot be measured" answer, not a divide-by-zero
    prog, _, total = P.project_progress(proj("zero", milestones=[{"status": "todo", "weight": 0}]))
    assert prog is None and total == 1


def test_evergreen_is_excluded_from_rollups_not_from_measurement():
    """The distinction the old suite lost.

    It asserted project_progress(evergreen) is None, which held only while evergreen catchments
    happened to be unseeded. project_progress has never known about `evergreen` — it reports on
    whatever milestones a project has, and per #712 those fills ARE the health signal for a
    catchment. Exclusion is goal_rollup's and classify's job, and that is what this pins.
    """
    ever = proj("ever", evergreen=True, milestones=[{"status": "active", "weight": 1, "fill": 0.4}])
    live = proj("live", milestones=[{"status": "done", "weight": 1}])
    prog, _, _ = P.project_progress(ever)
    assert approx(prog, 0.4), prog          # still measurable
    assert P.classify(ever) == "evergreen"  # but bucketed as a catchment
    assert approx(P.goal_rollup([ever, live], "GX"), 1.0)   # and absent from the rollup


def test_goal_rollup_excludes_paused_and_evergreen():
    projects = [
        proj("active-one", priority="P2", milestones=[{"status": "done", "weight": 1}]),
        proj("paused-one", status="paused", milestones=[{"status": "todo", "weight": 1, "fill": 0}]),
        proj("evergreen-one", evergreen=True, milestones=[{"status": "todo", "weight": 1, "fill": 0}]),
        proj("unseeded-one", milestones=[]),
        proj("other-goal", goal="GY", milestones=[{"status": "todo", "weight": 1, "fill": 0}]),
    ]
    assert approx(P.goal_rollup(projects, "GX"), 1.0), P.goal_rollup(projects, "GX")


def test_goal_rollup_is_none_when_nothing_qualifies():
    assert P.goal_rollup([proj("p", status="paused", milestones=[{"status": "done"}])], "GX") is None
    assert P.goal_rollup([], "GX") is None


def test_priority_weighted_rollup():
    # one P1 at 1.0, one P3 at 0.0 → (3×1 + 1×0)/(3+1) = 0.75
    fake = [
        proj("a", priority="P1", milestones=[{"status": "done", "weight": 1}]),
        proj("b", priority="P3", milestones=[{"status": "todo", "weight": 1, "fill": 0}]),
    ]
    assert approx(P.goal_rollup(fake, "GX"), 0.75)


def test_explicit_project_weight_overrides_priority():
    fake = [
        proj("a", priority="P3", weight=9, milestones=[{"status": "done", "weight": 1}]),
        proj("b", priority="P1", milestones=[{"status": "todo", "weight": 1, "fill": 0}]),
    ]
    assert approx(P.goal_rollup(fake, "GX"), 9 / 12)


def test_classify_deterministic_buckets():
    """Only the time-independent branches. moving vs attention turns on days_since_movement
    against wall-clock today, and classify() takes no `today` — pinning those here would make
    the suite fail on a clock, not on a defect."""
    assert P.classify(proj("e", evergreen=True)) == "evergreen"
    assert P.classify(proj("p", status="paused")) == "paused"
    assert P.classify(proj("d", milestones=[{"status": "done", "weight": 1}])) == "done"
    # blocked on the project, or on its current milestone, is a decision either way
    assert P.classify(proj("b1", status="blocked",
                           milestones=[{"status": "active", "weight": 1}])) == "decision"
    assert P.classify(proj("b2", milestones=[{"status": "done"},
                                             {"status": "blocked", "weight": 1}])) == "decision"


def test_current_milestone_is_the_first_unshipped():
    p = proj("c", milestones=[{"status": "done", "id": "M1"},
                              {"status": "active", "id": "M2"},
                              {"status": "todo", "id": "M3"}])
    assert P.current_milestone(p)["id"] == "M2"
    assert P.current_milestone(proj("all-done", milestones=[{"status": "done"}])) is None


def test_bar_render():
    assert P.bar(0.0) == "░" * 10
    assert P.bar(1.0) == "█" * 10
    assert P.bar(None) == "—" * 10


def test_live_projects_file_satisfies_the_contract():
    """The live file, checked for what must ALWAYS hold rather than for today's numbers.

    This is the part worth running against production state: it catches a malformed edit or a
    schema drift without pinning any value a human is allowed to change.
    """
    assert PROJECTS, "projects.json has no projects"
    seen_goals = set()
    for p in PROJECTS:
        slug = p.get("slug")
        assert slug, f"project with no slug: {p}"
        prog, shipped, total = P.project_progress(p)
        assert prog is None or 0.0 <= prog <= 1.0, f"{slug}: progress out of range ({prog})"
        assert 0 <= shipped <= total, f"{slug}: shipped {shipped} of {total}"
        # The shipped count must equal the done count exactly — that annotation is the honesty
        # floor the contract leans on, so it is the one number that may never drift. The
        # percentage is NOT clamped below 1.0; see test_shipped_count_is_the_honesty_floor.
        done_n = sum(1 for m in (p.get("milestones") or []) if m.get("status") == "done")
        assert shipped == done_n, f"{slug}: shipped {shipped} but {done_n} milestones are done"
        assert P.classify(p) in {"decision", "attention", "moving", "paused", "evergreen", "done"}
        if p.get("goal"):
            seen_goals.add(p["goal"])
    for g in sorted(seen_goals):
        r = P.goal_rollup(PROJECTS, g)
        assert r is None or 0.0 <= r <= 1.0, f"{g}: rollup out of range ({r})"


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
