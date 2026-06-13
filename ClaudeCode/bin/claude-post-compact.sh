#!/bin/bash
# Re-inject working-context.md after Claude Code compacts the context window.
# Prevents Claude from losing task state mid-session after compaction.

WORKING_CTX="${METIS_HOME:-$HOME/metis-os}/<<MACHINE_1_ID>>/memory/working-context.md"

if [ ! -f "$WORKING_CTX" ]; then
  exit 0
fi

python3 -c "
import json

with open('$WORKING_CTX') as f:
    ctx = f.read().strip()

output = {
    'hookSpecificOutput': {
        'hookEventName': 'PostCompact',
        'additionalContext': (
            'CONTEXT WAS JUST COMPACTED. Re-injecting session state.\n\n'
            'working-context.md (current task / open threads):\n'
            + ctx
        )
    }
}
print(json.dumps(output))
"
