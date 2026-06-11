# Plan Template — docs/plans/PLAN-<slug>.md

```markdown
# Plan — <task title>  (<#NNN if governed>)

**Status:** draft
**Created:** <YYYY-MM-DD> by <agent>@<machine>
**Task:** <#NNN or "ad-hoc">

## Goal (what + why)
<one-paragraph: the outcome and the reason it matters>

## Current state (READ, not guessed — Step 1)
<what the repo actually does today: real stack, entry points, existing patterns to reuse. Cite file paths.>

## Approach (chosen + alternatives weighed)
<the path you'll take, and the 1-2 alternatives you rejected and why — grounded in scout research>

## Steps (ordered)
1. <step> → <lane/owner: forge/scout/shield/claude>
2. ...

## Files touched
- <path> — <create/edit, what changes>

## Verification / done-when
<the concrete check that proves it works — feeds the task's verificationMethod>

## Risks & open questions
- <risk or unknown that could change the plan>
```

## Notes on the template
- **Current state must be read, not guessed.** Cite actual file paths. A plan with "I assume the stack is X" in this section is invalid.
- **Approach must weigh alternatives.** "I chose X" with no rejected alternatives is a decision with no reasoning — future sessions can't tell if the alternative was considered or missed.
- **Verification must be concrete.** "It works" is not verifiable. "curl http://localhost:8080/api/all returns `system.cpu_pct` field" is.
- **Keep it tight.** A plan is a decision record, not a design doc. Each section should be scannable in 30 seconds.
