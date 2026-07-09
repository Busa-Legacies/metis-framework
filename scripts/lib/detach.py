#!/usr/bin/env python3
"""setsid detacher for poller-launched long jobs (#440).

nohup + disown drops the controlling terminal but leaves the child in the
LaunchAgent's process GROUP, so launchd reaps it when the poller's job cycle
ends (AbandonProcessGroup defaults to false). macOS ships no setsid(1), so this
is the portable equivalent: spawn the worker with start_new_session=True —
setsid() in the child — putting it in its own session/process group, out of
reap range.

Usage: detach.py <logfile> <cmd> [args...]
Appends the worker's combined output to <logfile>, prints the worker pid.
"""
import subprocess
import sys


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: detach.py <logfile> <cmd> [args...]", file=sys.stderr)
        return 2
    log, cmd = sys.argv[1], sys.argv[2:]
    with open(log, "ab") as f:
        p = subprocess.Popen(
            cmd,
            stdout=f,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    print(p.pid)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
