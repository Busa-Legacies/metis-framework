#!/usr/bin/env python3
import argparse
import json
import sys
from datetime import datetime
from dataclasses import dataclass, asdict, field
from pathlib import Path


def find_repo_root(start_path=None):
    if start_path is None:
        start_path = Path(__file__).resolve().parent
    path = Path(start_path).resolve()
    while path != path.parent:
        if (path / "docs" / "process" / "state").is_dir():
            return path
        path = path.parent
    raise RuntimeError("Could not find repository root (docs/process/state not found)")


REPO = find_repo_root()
STATE_DIR = REPO / "docs" / "process" / "state"
DECISIONS_FILE = STATE_DIR / "decisions.json"
COUNTER_FILE = STATE_DIR / "decision-counter.json"


def load_records():
    if DECISIONS_FILE.exists():
        return json.loads(DECISIONS_FILE.read_text())
    return []


def save_records(records):
    DECISIONS_FILE.write_text(json.dumps(records, indent=2, sort_keys=True))


def alloc_id():
    counter = json.loads(COUNTER_FILE.read_text())["next"] if COUNTER_FILE.exists() else 1
    COUNTER_FILE.write_text(json.dumps({"next": counter + 1}))
    return f"dec-{counter:04d}"


@dataclass
class DecisionRecord:
    decision_id: str
    title: str
    status: str                          # 'pending' | 'resolved' | 'skipped'
    created_at: str
    task_context: str
    criteria: list[str]
    weights: dict[str, float]            # raw values, normalized at compute time
    options: list[str]
    scores: dict[str, dict[str, float]]  # {option: {criterion: raw_score}}
    recommended: str | None = None
    chosen: str | None = None
    rationale: str | None = None
    resolved_at: str | None = None
    resolved_by: str | None = None
    dr_link: str | None = None
    metadata: dict = field(default_factory=dict)


def compute_scores(record):
    total_weight = sum(record.weights.values())
    normalized = {c: w / total_weight for c, w in record.weights.items()}
    return {
        opt: sum(normalized[c] * record.scores.get(opt, {}).get(c, 0) for c in record.criteria)
        for opt in record.options
    }


def print_matrix(record):
    weighted = compute_scores(record)
    # header
    col_w = 10
    header = f"{'Option':<{col_w}}" + "".join(f"{c[:8]:>9}" for c in record.criteria) + f"{'Weighted':>10}"
    print(header)
    print("-" * len(header))
    for opt in record.options:
        row = f"{opt:<{col_w}}"
        for c in record.criteria:
            row += f"{record.scores.get(opt, {}).get(c, 0):>9.1f}"
        row += f"{weighted[opt]:>10.2f}"
        marker = " ◀ winner" if opt == record.recommended else ""
        print(row + marker)


def new_decision(args):
    if args.non_interactive:
        if not all([args.title, args.task_context, args.criteria, args.weights, args.options]):
            print("error: --title --task-context --criteria --weights --options are required", file=sys.stderr)
            sys.exit(1)
        criteria = [c.strip() for c in args.criteria.split(",")]
        weights = dict(zip(criteria, [float(w) for w in args.weights.split(",")]))
        options = [o.strip() for o in args.options.split(",")]
        raw_scores = {}
        if args.scores:
            for entry in args.scores.split(";"):
                opt, vals = entry.split(":")
                raw_scores[opt.strip()] = dict(zip(criteria, [float(s) for s in vals.split(",")]))
    else:
        title = input("Title: ").strip()
        task_context = input("Task context (#NNN or free text): ").strip()
        criteria = input("Criteria (space-separated): ").strip().split()
        weights = {}
        for c in criteria:
            weights[c] = float(input(f"  Weight for '{c}' (1-5): "))
        options = input("Options (space-separated): ").strip().split()
        raw_scores = {}
        for opt in options:
            raw_scores[opt] = {}
            for c in criteria:
                raw_scores[opt][c] = float(input(f"  Score for '{opt}' on '{c}' (1-5): "))
        args.title, args.task_context = title, task_context

    record = DecisionRecord(
        decision_id=alloc_id(),
        title=args.title,
        status="pending",
        created_at=datetime.now().isoformat(),
        task_context=args.task_context,
        criteria=criteria,
        weights=weights,
        options=options,
        scores=raw_scores,
    )
    weighted = compute_scores(record)
    record.recommended = max(weighted, key=weighted.get)

    records = load_records()
    records.append(asdict(record))
    save_records(records)

    print(f"\nDecision {record.decision_id} created — recommended: {record.recommended}")
    print_matrix(record)


def score_decision(args):
    records = load_records()
    idx, record = next(((i, DecisionRecord(**r)) for i, r in enumerate(records) if r["decision_id"] == args.id), (None, None))
    if record is None:
        print(f"error: {args.id} not found", file=sys.stderr)
        sys.exit(1)
    if record.status != "pending":
        print(f"error: {args.id} is not pending", file=sys.stderr)
        sys.exit(1)

    raw_scores = {}
    for opt in record.options:
        raw_scores[opt] = {}
        for c in record.criteria:
            raw_scores[opt][c] = float(input(f"Score for '{opt}' on '{c}' (1-5): "))

    record.scores = raw_scores
    weighted = compute_scores(record)
    record.recommended = max(weighted, key=weighted.get)
    records[idx] = asdict(record)
    save_records(records)

    print(f"\nRecommended: {record.recommended}")
    print_matrix(record)


def list_decisions(args):
    records = load_records()
    if args.json:
        print(json.dumps(records, indent=2, sort_keys=True))
        return
    if not records:
        print("No decisions recorded.")
        return
    print(f"{'ID':<10} {'Title':<32} {'Status':<10} {'Recommended':<14} {'Created'}")
    print("-" * 78)
    for r in records:
        status_disp = {"pending": "PENDING", "resolved": "RESOLVED", "skipped": "SKIPPED"}.get(r["status"], r["status"])
        print(f"{r['decision_id']:<10} {r['title'][:30]:<32} {status_disp:<10} {(r['recommended'] or 'N/A'):<14} {r['created_at'][:10]}")


def show_decision(args):
    records = load_records()
    record = next((DecisionRecord(**r) for r in records if r["decision_id"] == args.id), None)
    if record is None:
        print(f"error: {args.id} not found", file=sys.stderr)
        sys.exit(1)

    print(f"ID:           {record.decision_id}")
    print(f"Title:        {record.title}")
    print(f"Status:       {record.status}")
    print(f"Created:      {record.created_at[:19]}")
    print(f"Context:      {record.task_context}")
    print(f"Criteria:     {', '.join(record.criteria)}")
    print(f"Options:      {', '.join(record.options)}")
    print(f"Recommended:  {record.recommended or 'N/A'}")
    if record.dr_link:
        print(f"DR link:      {record.dr_link}")
    if record.status == "resolved":
        print(f"Chosen:       {record.chosen}")
        print(f"Rationale:    {record.rationale}")
        print(f"Resolved at:  {record.resolved_at[:19] if record.resolved_at else 'N/A'}")
        print(f"Resolved by:  {record.resolved_by}")
    if record.scores:
        print()
        print_matrix(record)


def resolve_decision(args):
    records = load_records()
    idx, record = next(((i, DecisionRecord(**r)) for i, r in enumerate(records) if r["decision_id"] == args.id), (None, None))
    if record is None:
        print(f"error: {args.id} not found", file=sys.stderr)
        sys.exit(1)
    if record.status != "pending":
        print(f"error: {args.id} is not pending", file=sys.stderr)
        sys.exit(1)
    if args.chosen not in record.options:
        print(f"error: '{args.chosen}' not in options: {record.options}", file=sys.stderr)
        sys.exit(1)

    record.status = "resolved"
    record.chosen = args.chosen
    record.rationale = args.rationale
    record.resolved_at = datetime.now().isoformat()
    record.resolved_by = args.by
    records[idx] = asdict(record)
    save_records(records)
    print(f"Decision {args.id} resolved → {args.chosen}")


def skip_decision(args):
    records = load_records()
    idx, record = next(((i, DecisionRecord(**r)) for i, r in enumerate(records) if r["decision_id"] == args.id), (None, None))
    if record is None:
        print(f"error: {args.id} not found", file=sys.stderr)
        sys.exit(1)

    record.status = "skipped"
    if args.reason:
        record.metadata["skip_reason"] = args.reason
    records[idx] = asdict(record)
    save_records(records)
    print(f"Decision {args.id} skipped")


def main():
    parser = argparse.ArgumentParser(prog="decide", description="Weighted decision matrix CLI")
    sub = parser.add_subparsers(dest="command")

    p_new = sub.add_parser("new", help="Create and score a new decision")
    p_new.add_argument("--non-interactive", action="store_true")
    p_new.add_argument("--title")
    p_new.add_argument("--task-context")
    p_new.add_argument("--criteria", help="comma-separated")
    p_new.add_argument("--weights", help="comma-separated, same order as criteria")
    p_new.add_argument("--options", help="comma-separated")
    p_new.add_argument("--scores", help="opt:s1,s2,...;opt2:s1,s2,... (same order as criteria)")

    p_score = sub.add_parser("score", help="Fill in scores for a pending decision")
    p_score.add_argument("id")

    p_list = sub.add_parser("list", help="List decisions")
    p_list.add_argument("--json", action="store_true")

    p_show = sub.add_parser("show", help="Show decision detail")
    p_show.add_argument("id")

    p_res = sub.add_parser("resolve", help="Resolve a decision")
    p_res.add_argument("id")
    p_res.add_argument("--chosen", required=True)
    p_res.add_argument("--rationale", required=True)
    p_res.add_argument("--by", choices=["claude", "ant", "smith", "scout", "main"], default="claude")

    p_skip = sub.add_parser("skip", help="Skip a decision")
    p_skip.add_argument("id")
    p_skip.add_argument("--reason")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return

    dispatch = {"new": new_decision, "score": score_decision, "list": list_decisions,
                "show": show_decision, "resolve": resolve_decision, "skip": skip_decision}
    dispatch[args.command](args)


if __name__ == "__main__":
    main()
