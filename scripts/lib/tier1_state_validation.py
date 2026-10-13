"""Validation + shape helpers extracted from update-tier1-state.py (#6460 Slice 2).

Byte-faithful move via scripts/extract-symbols.py: pure validators plus their validation-local
constant sets (_REACTIVATE_STATES, _EMPTY_VALUES, DUP_TERMINAL_STATES, APPEND_ONLY_FIELDS), no
I/O. Broad shared enums stay in tier1_state_constants; validation-specific sets live here with
their only users. The mutator re-imports every name so callers are unchanged. IO-coupled
validators (project/area/board-field loaders, the done-gate and its coverage nudge) stay in
update-tier1-state.py — they read task/project files.
"""
from __future__ import annotations

import json  # noqa: F401  (used by moved validators)
import os
import re  # noqa: F401  (used by moved validators)
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tier1_state_constants import (  # noqa: E402
    ALLOWED_STATE_TRANSITIONS,
    FOCUS_MUTABLE_FIELDS,
    REQUIRED_RICH_FIELDS,
    RICH_REQUIRED_STATES,
    TASK_MUTABLE_FIELDS,
    VALID_DONEWHEN_TYPES,
    VALID_NEEDS_YOU_KINDS,
    VALID_NEEDS_YOU_KIND_SOURCES,
    VALID_TASK_STATES,
    VALID_WAKE_ACTIONS,
    VALID_WAKE_TYPES,
)


def parse_patch(patch_text: str):
    try:
        patch = json.loads(patch_text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid patch JSON: {exc}")
    if not isinstance(patch, dict):
        raise ValueError("patch must decode to a JSON object")
    return patch


def validate_task_shape(task_id: str, task: dict, require_rich: bool = True):
    state = task.get("state")
    if state not in VALID_TASK_STATES:
        raise ValueError(f"{task_id}: invalid state {state!r}")

    if require_rich and state in RICH_REQUIRED_STATES:
        missing = [field for field in REQUIRED_RICH_FIELDS if not task.get(field)]
        if missing:
            raise ValueError(
                f"{task_id}: missing required rich fields for state {state}: {', '.join(missing)}"
            )

    if state == "done" and task.get("blockerOrNone") not in (None, "", "none"):
        raise ValueError(f"{task_id}: done task should not carry a meaningful blocker")

    if state == "execution_finished" and not task.get("verificationMethod"):
        raise ValueError(f"{task_id}: execution_finished task must preserve verificationMethod")

    validate_done_when(task_id, task)
    validate_wake(task_id, task)
    validate_dates(task_id, task)
    validate_decision(task_id, task)
    needs_you_kind = task.get("needsYouKind")
    if needs_you_kind is not None and needs_you_kind not in VALID_NEEDS_YOU_KINDS:
        raise ValueError(
            f"{task_id}: invalid needsYouKind {needs_you_kind!r} "
            f"(valid: {', '.join(sorted(VALID_NEEDS_YOU_KINDS))})"
        )
    kind_source = task.get("kindSource")
    if kind_source is not None and kind_source not in VALID_NEEDS_YOU_KIND_SOURCES:
        raise ValueError(
            f"{task_id}: invalid kindSource {kind_source!r} "
            f"(valid: {', '.join(sorted(VALID_NEEDS_YOU_KIND_SOURCES))})"
        )


def validate_title(task_id: str, task: dict):
    """Titles must STAND ALONE (Ant 2026-06-29): a "#NNN" task-number reference in a
    title is meaningless without looking that number up, and makes tasks hard to tell
    apart on the board and in conversation. Reject a task-number token in the title so
    every title is self-descriptive and distinguishable. Applied at create time only
    (legacy titles are grandfathered)."""
    title = str(task.get("title", ""))
    numref = re.search(r"#\d{2,}", title)
    if numref:
        raise ValueError(
            f"{task_id}: title must stand alone — a '{numref.group()}' task-number "
            f"reference is meaningless without lookup. Rewrite it descriptively: {title!r}"
        )


# States a task is in when it no longer occupies the live board — a normalized-title
# match against one of these is NOT a duplicate (the prior instance is closed out).
DUP_TERMINAL_STATES = {"done", "dropped", "cancelled", "archived", "superseded"}


def _dup_norm(title: str) -> str:
    """Normalize a title for near-duplicate detection: lowercase, collapse whitespace,
    and fold every run of digits to a single '#'. This is what makes the guard catch
    the self-amplifying-minter class — "Reconcile 42 task-board drift items" and
    "Reconcile 43 task-board drift items" normalize to the SAME key, so the second
    create is refused instead of piling a fresh near-identical card onto the board."""
    s = re.sub(r"\d+", "#", str(title or "").strip().lower())
    return re.sub(r"\s+", " ", s).strip()


def find_near_duplicate(tasks, title, exclude_id=None):
    """Return the oldest OPEN task whose normalized title equals `title`'s, or None.
    Only live (non-terminal) tasks count — a closed prior instance never blocks a new
    create. Oldest-first so the returned id is the stable canonical to fold into."""
    key = _dup_norm(title)
    if not key:
        return None
    matches = [
        t for t in tasks
        if isinstance(t, dict)
        and t.get("taskId") != exclude_id
        and t.get("state") not in DUP_TERMINAL_STATES
        and _dup_norm(t.get("title")) == key
    ]
    matches.sort(key=lambda t: t.get("createdAt") or t.get("taskId") or "")
    return matches[0] if matches else None


def validate_decision(task_id: str, task: dict):
    """Validate the optional structured decision affordances (#323, decision-inbox).
    Both Notion and Control Center render these instead of scraping nextDecisionPoint prose:
      decisionOptions: [{"key": "a", "label": "...", "detail"?: "..."}]  # the one-tap choices
      recommendation:  "<key or short text> — why"                       # agent's pick
      decisionContext: "why it matters / trade-offs / links"             # context to decide
    """
    opts = task.get("decisionOptions")
    if opts is not None:
        if not isinstance(opts, list) or not opts:
            raise ValueError(f"{task_id}: decisionOptions must be a non-empty list")
        keys = set()
        for o in opts:
            if not isinstance(o, dict):
                raise ValueError(f"{task_id}: each decisionOption must be an object {{key,label}}")
            k, label = o.get("key"), o.get("label")
            if not isinstance(k, str) or not k.strip():
                raise ValueError(f"{task_id}: decisionOption needs a non-empty 'key'")
            if not isinstance(label, str) or not label.strip():
                raise ValueError(f"{task_id}: decisionOption {k!r} needs a non-empty 'label'")
            if "detail" in o and not isinstance(o["detail"], str):
                raise ValueError(f"{task_id}: decisionOption {k!r} 'detail' must be a string")
            if k in keys:
                raise ValueError(f"{task_id}: duplicate decisionOption key {k!r}")
            keys.add(k)
    for f in ("recommendation", "decisionContext"):
        v = task.get(f)
        if v is not None and (not isinstance(v, str) or not v.strip()):
            raise ValueError(f"{task_id}: {f} must be a non-empty string when present")

    warn_unstructured_decision(task_id, task)


def warn_unstructured_decision(task_id: str, task: dict):
    """Safety net (#326): a genuine Ant-decision must be BORN structured, or it
    silently renders as scraped prose instead of a one-tap card (#280/#314/#323).
    Nothing enforced that before. Heuristic (Ant 2026-07-20): owner==ant AND a
    non-empty nextDecisionPoint AND no decisionOptions == a thin prose decision.
    WARN (not raise) — the signal has false positives (an ant-owned task need not
    be a decision), so surface it without blocking creation; promote to a hard
    gate later if the warning proves reliable."""
    opts = task.get("decisionOptions")
    ndp = task.get("nextDecisionPoint")
    if (task.get("owner") == "ant" and not opts
            and isinstance(ndp, str) and ndp.strip()):
        print(
            f"WARN {task_id}: looks like an Ant-decision (owner=ant + nextDecisionPoint "
            f"prose) but has no decisionOptions — it will render as scraped prose, not a "
            f"one-tap card. Add decisionOptions/recommendation/decisionContext (#326).",
            file=sys.stderr,
        )


def validate_done_when(task_id: str, task: dict):
    """Validate the optional structured doneWhen (queue-runner-v2). When present it
    must be USABLE — the v2 runner executes the check or arbiter judges the
    criteria, so a malformed contract would silently break the apply+verify loop.
      {"type": "check"|"acceptance"|"both",
       "check": "<shell command, exit 0 = pass>",   # required for check/both
       "criteria": ["explicit acceptance bullet", ...]}  # required for acceptance/both
    """
    dw = task.get("doneWhen")
    if dw is None:
        return
    if not isinstance(dw, dict):
        raise ValueError(f"{task_id}: doneWhen must be an object")
    dtype = dw.get("type")
    if dtype not in VALID_DONEWHEN_TYPES:
        raise ValueError(
            f"{task_id}: doneWhen.type must be one of {', '.join(sorted(VALID_DONEWHEN_TYPES))}"
        )
    if dtype in {"check", "both"}:
        check = dw.get("check")
        if not isinstance(check, str) or not check.strip():
            raise ValueError(
                f"{task_id}: doneWhen.type={dtype} requires a non-empty 'check' command string"
            )
    if dtype in {"acceptance", "both"}:
        crit = dw.get("criteria")
        if not isinstance(crit, list) or not crit or not all(
            isinstance(c, str) and c.strip() for c in crit
        ):
            raise ValueError(
                f"{task_id}: doneWhen.type={dtype} requires a non-empty 'criteria' list of strings"
            )


def validate_wake(task_id: str, task: dict):
    """Validate the optional structured wakeWhen / wakeAction (task-wake sweep). When present
    they must be USABLE — the sweep evaluates the condition and auto-fires the action
    unattended, so a malformed contract would silently never wake (or misfire).
      wakeWhen: {"type":"time","at":"<ISO date/datetime>"}
                {"type":"check","cmd":"<shell command, exit 0 = ready>", "note"?:"..."}
      wakeAction (optional): {"kind":"dispatch"|"requeue"|"needs_you",
                              "agent"?:"<lane>", "message"?:"<follow-up>", "engine"?:"..."}
    """
    ww = task.get("wakeWhen")
    if ww is not None:
        if not isinstance(ww, dict):
            raise ValueError(f"{task_id}: wakeWhen must be an object")
        wtype = ww.get("type")
        if wtype not in VALID_WAKE_TYPES:
            raise ValueError(
                f"{task_id}: wakeWhen.type must be one of {', '.join(sorted(VALID_WAKE_TYPES))}")
        if wtype == "time":
            at = ww.get("at")
            if not isinstance(at, str) or not at.strip():
                raise ValueError(f"{task_id}: wakeWhen.type=time requires an ISO 'at' string")
            from datetime import datetime as _dt
            try:
                _dt.fromisoformat(at.replace("Z", "+00:00"))
            except ValueError:
                raise ValueError(f"{task_id}: wakeWhen.at is not a valid ISO date/datetime: {at!r}")
        if wtype == "check":
            cmd = ww.get("cmd")
            if not isinstance(cmd, str) or not cmd.strip():
                raise ValueError(f"{task_id}: wakeWhen.type=check requires a non-empty 'cmd' string")
        # A wakeWhen only makes sense for a paused task; the sweep only scans `waiting`.
        if task.get("state") not in (None, "waiting"):
            raise ValueError(
                f"{task_id}: wakeWhen only applies to a `waiting` task (state={task.get('state')!r}); "
                f"the wake sweep scans waiting tasks only")

    wa = task.get("wakeAction")
    if wa is not None:
        if not isinstance(wa, dict):
            raise ValueError(f"{task_id}: wakeAction must be an object")
        kind = wa.get("kind")
        if kind not in VALID_WAKE_ACTIONS:
            raise ValueError(
                f"{task_id}: wakeAction.kind must be one of {', '.join(sorted(VALID_WAKE_ACTIONS))}")


def _validate_iso_date(label: str, val) -> None:
    """Shared guard for the human-set date fields (dueAt / followUpAt / milestone+project dueAt).
    Accepts an ISO date ('2026-08-20') or datetime; None/'' clears the field. A malformed date is
    rejected loudly so a typo can never sit silently un-surfaced by the overdue/follow-up sweep."""
    if val is None or (isinstance(val, str) and not val.strip()):
        return
    if not isinstance(val, str):
        raise ValueError(f"{label} must be an ISO date string (e.g. '2026-08-20') or null, got {val!r}")
    from datetime import datetime as _dt
    try:
        _dt.fromisoformat(val.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError(f"{label} is not a valid ISO date/datetime: {val!r}")


def validate_dates(task_id: str, task: dict):
    """#DUE: validate the human-set date fields. Distinct from wakeWhen (automated self-trigger)
    and completedAt (system-stamped) — see docs/process/task-state-contract.md §DUE:
      dueAt         — HARD deadline (sparse; only a real committed date).
      followUpAt    — SOFT human check-back (parked/blocked work; surfaces, never auto-runs).
      followUpReason— free text describing WHY to check back."""
    _validate_iso_date(f"{task_id}: dueAt", task.get("dueAt"))
    _validate_iso_date(f"{task_id}: followUpAt", task.get("followUpAt"))
    fr = task.get("followUpReason")
    if fr is not None and not isinstance(fr, str):
        raise ValueError(f"{task_id}: followUpReason must be a string or null, got {fr!r}")


# #2237 give-up circuit breaker: the rejectStreak counter is auto-cleared the moment a
# task is REACTIVATED — a human re-queues a parked/blocked task or someone re-claims it into
# in_progress. That is the unambiguous "give it another chance" signal the breaker's park
# note points a human at, and it re-admits the task to the queue-runner's eligible set on the
# next tick. A patch may still set rejectStreak explicitly (it is a mutable field); this only
# forces the reset on the reactivating transitions so a stale streak can't silently keep a
# revived task frozen out of dispatch.
_REACTIVATE_STATES = {"queued", "in_progress", "accepted", "open"}


def _reset_reject_streak_on_reactivate(new_task: dict, old_state, patch: dict | None = None):
    new_state = new_task.get("state")
    if (
        new_state in _REACTIVATE_STATES
        and new_state != old_state
        and new_task.get("rejectStreak")
        and not (patch and "rejectStreak" in patch)  # an explicit patch value wins
    ):
        new_task["rejectStreak"] = 0


def validate_task_patch(task_id: str, patch: dict):
    unknown = sorted(set(patch.keys()) - TASK_MUTABLE_FIELDS)
    if unknown:
        raise ValueError(f"{task_id}: unknown task patch fields: {', '.join(unknown)}")
    state = patch.get("state")
    if state is not None and state not in VALID_TASK_STATES:
        raise ValueError(f"{task_id}: invalid state {state!r}")
    needs_you_kind = patch.get("needsYouKind")
    if needs_you_kind is not None and needs_you_kind not in VALID_NEEDS_YOU_KINDS:
        raise ValueError(
            f"{task_id}: invalid needsYouKind {needs_you_kind!r} "
            f"(valid: {', '.join(sorted(VALID_NEEDS_YOU_KINDS))})"
        )
    kind_source = patch.get("kindSource")
    if kind_source is not None and kind_source not in VALID_NEEDS_YOU_KIND_SOURCES:
        raise ValueError(
            f"{task_id}: invalid kindSource {kind_source!r} "
            f"(valid: {', '.join(sorted(VALID_NEEDS_YOU_KIND_SOURCES))})"
        )


# #1034: currentStep/nextAction record progress narrative — a patch that REPLACES
# instead of appends erases that narrative (the 2026-07-08 sweep, #697) and can cause
# an already-answered decision to get re-asked. feedback_task_fields_append_never_replace
# documented "append, never replace" as an advisory-only convention (mutator did not
# enforce it), which is why self-heal's task-progress-clobber check kept re-firing
# (task-progress-watch.py's raw nextAction stamps + ad hoc session currentStep
# rewrites both slipped through). Enforce it here instead of trusting every caller.
APPEND_ONLY_FIELDS = ("currentStep", "nextAction")


_EMPTY_VALUES = {"", "none", "n/a", "null"}


def _enforce_append_only(task_id: str, old_task: dict, patch: dict) -> None:
    for field in APPEND_ONLY_FIELDS:
        if field not in patch:
            continue
        old_val = str(old_task.get(field) or "").strip()
        new_val = str(patch[field] or "").strip()
        if not old_val or old_val.lower() in _EMPTY_VALUES:
            continue  # nothing recorded yet — nothing to lose
        if new_val.lower() in _EMPTY_VALUES:
            continue  # intentional clear (e.g. done-gate forces nextAction -> none)
        if old_val in new_val:
            continue  # already append-safe (caller did the right thing, or a no-op)
        # Raw replacement of recorded progress — auto-append rather than accept the
        # clobber or hard-reject every caller that hasn't adopted the convention.
        patch[field] = f"{old_val} || {new_val}"
        print(
            f"[append-guard] {task_id}.{field}: patch would have replaced recorded "
            "progress — auto-appended instead (pass the merged value yourself to avoid this)",
            file=sys.stderr,
        )


def _current_session() -> str:
    """Current agent session id — distinguishes two SAME-ROLE sessions editing one task
    (the #4612 overlap case: two 'claude' sessions both closed out the same task, both
    stamped updatedBy='claude'). Empty when unknown; the overlap check then degrades to a
    role compare."""
    for var in ("CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "OPENCLAW_SESSION"):
        v = os.environ.get(var)
        if v:
            return v
    return ""


def _state_overlap_warn(task: dict, actor: str) -> None:
    """Advisory soft-warning (#4612): if another session state-edited this task within a
    short window, surface the likely decision-overlap on stderr BEFORE this edit lands.
    NEVER blocks and never raises — revision-CAS protects the data and leases gate
    execution; this only flags duplicated concurrent effort (two sessions independently
    closing out one task, which takes no lease and so nothing else catches). Reads the
    task's existing updatedBySession/updatedBy/updatedAt — no new storage, no merge-driver
    change. Kill-switch: OPENCLAW_STATE_OVERLAP_WARN=0. Window: OPENCLAW_STATE_OVERLAP_WINDOW_MIN
    (default 15)."""
    try:
        if os.environ.get("OPENCLAW_STATE_OVERLAP_WARN") == "0":
            return
        last_at = task.get("updatedAt")
        if not isinstance(last_at, str) or not last_at:
            return
        # Prefer session identity (catches two same-role sessions); fall back to actor role
        # for tasks last edited before updatedBySession existed.
        me_session = _current_session()
        last_session = task.get("updatedBySession")
        if last_session and me_session:
            if last_session == me_session:
                return  # same session re-editing its own task — not an overlap
        else:
            last_by = task.get("updatedBy")
            if not last_by or last_by == actor:
                return  # can't distinguish sessions, or same role — stay quiet
        from datetime import datetime, timezone

        s = last_at[:-1] + "+00:00" if last_at.endswith(("Z", "z")) else last_at
        try:
            t = datetime.fromisoformat(s)
        except ValueError:
            return
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        try:
            window_min = float(os.environ.get("OPENCLAW_STATE_OVERLAP_WINDOW_MIN", "15"))
        except ValueError:
            window_min = 15.0
        age_min = (datetime.now(timezone.utc) - t).total_seconds() / 60.0
        if not (0 <= age_min <= window_min):
            return
        who = task.get("updatedBy") or "another session"
        print(
            f"⚠ overlap: {task.get('taskId', '?')} was state-edited by {who} "
            f"{age_min:.0f}m ago — another session may be working this out; proceeding "
            f"(advisory, CAS protects data, leases gate execution).",
            file=sys.stderr,
        )
    except Exception:
        # Advisory only: a bug in the signal must never break a state edit.
        return


def validate_focus_patch(patch: dict):
    unknown = sorted(set(patch.keys()) - FOCUS_MUTABLE_FIELDS)
    if unknown:
        raise ValueError(f"live-focus: unknown patch fields: {', '.join(unknown)}")


def validate_state_transition(task_id: str, old_state: str, new_state: str):
    if old_state == new_state:
        return
    allowed = ALLOWED_STATE_TRANSITIONS.get(old_state, set())
    if new_state not in allowed:
        raise ValueError(f"{task_id}: invalid state transition {old_state!r} -> {new_state!r}")
