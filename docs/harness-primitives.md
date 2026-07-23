# Metis as a long-running-agent harness

Anthropic's [*Harness design for long-running application development*](https://www.anthropic.com/engineering/harness-design-long-running-apps)
names five primitives a system needs so an AI agent can work across **many fresh-context
sessions** (each starting with no memory of the last) and still pick up cleanly, prove its
work, and hand off without a human babysitting every step.

Metis was built on that same problem and **independently converged on four of the five**. This
doc maps each primitive to where the framework actually implements it, so a reader who knows the
article can see exactly what is and isn't here. It is an honest map, not a marketing claim: where
a primitive is partial, it says so.

> Metis is a **spine you vendor into your own operating repo** (via git subtree), not a turnkey
> product. The primitives below are mechanisms the framework gives you; you bring the work.

## The five primitives → where Metis implements them

| Primitive | What the article means | Where Metis does it |
|---|---|---|
| **1. Default-FAIL / evidence-first contract** | Every "done" starts `false`; an agent can't flip it `true` until it has **Read observed proof** (logs, test output, a screenshot). A gate blocks success claims without evidence. | The governed task DAG: a task stays `needs_verification` and cannot reach `done` until proof is recorded; enforced in [`scripts/update-tier1-state.py`](../scripts/update-tier1-state.py) (the done-gate) and specified in [`docs/process/doctrine-to-operations-bridge.md`](process/doctrine-to-operations-bridge.md). This runs as a **standing protocol across every agent**, not a per-project hook. |
| **2. Fresh-context evaluator** | A **separate** agent with **no write tools** grades the build from a context it never saw being made, returning a binary PASS / NEEDS_WORK that seeds the next session. | The `warden` (review/QA) and `arbiter` (quality gate) lanes in [`CLAUDE.md`](../CLAUDE.md) → Agent Routing. Contract: the evaluator **never saw the build and holds no write tools**; it grades from the artifact, diff, and evidence only, in a session distinct from the builder. |
| **3. Agent-maintained handoff** | A progress log + a commit-on-stop backstop carry state across the context boundary so the next session resumes exactly where this one stopped. | The session lifecycle skills [`checkpoint`](../ClaudeCode/skills/checkpoint) / [`end`](../ClaudeCode/skills/end): commit the work and refresh forward state under a lock, so a fresh context resumes from durable files, not chat. See [`docs/process/surgical-delivery-protocol.md`](process/surgical-delivery-protocol.md). |
| **4. Decomposed, one-feature-at-a-time work** | A planner expands a spec into a testable feature list; the coding agent does **one** feature per session, commits, tests end-to-end, then starts the next. | The [`plan`](../ClaudeCode/skills/plan) → [`build`](../ClaudeCode/skills/build) skills over a **forward-only task DAG** with leases + fencing tokens ([`scripts/agent-work.py`](../scripts/agent-work.py), [`scripts/update-tier1-state.py`](../scripts/update-tier1-state.py)) so parallel sessions never collide. |
| **5. Operator control hooks** | File-based mid-run control of an unattended loop: a kill-switch halts tool calls, a steer file injects a one-shot correction, and the outer loop has explicit budget/exit conditions. | **Partial.** Budgeted unattended windows with an independence test exist ([`docs/process/offline-autopilot-protocol.md`](process/offline-autopilot-protocol.md)); the lightweight in-band `AGENT_STOP` / `STEER` kill-and-steer surface is on the roadmap, not built. This is the "four of five." |

## Why this is the honest framing

- **Four of five, not five.** Primitive 5's in-band steer/kill surface isn't built; only the
  budget/exit half is. Counting it would overstate.
- **Independently converged.** Metis arrived at these primitives solving the same problem, not by
  copying the article. There's no endorsement, and no claim of precedence either way.
- **Stronger where it counts.** The evidence gate (primitive 1) is arguably stronger than the
  article's reference design: it's a standing protocol every lane obeys, rather than a hook a
  given project opts into.

If you've read the article and you're evaluating frameworks, this is the recognition point: Metis
is a working implementation of the pattern, battle-tested across real multi-session work, with the
one honest gap named above.
