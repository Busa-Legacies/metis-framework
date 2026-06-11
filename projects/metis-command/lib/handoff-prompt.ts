import type { MetisLease, MetisPriorityItem } from './metis-api-types'

/**
 * Pure builders for cross-agent handoff prompts (PLAN §4 — "copy handoff
 * prompt" is a read-only safe action: it generates a ready-to-paste context
 * string, mutates nothing). Used by the Work Graph to hand off / take over a
 * leased task or to spin up work on a queued one.
 */

/** Handoff/takeover prompt for an active lease. */
export function leaseHandoffPrompt(lease: MetisLease): string {
  const ref = lease.taskId ?? lease.title ?? 'this work'
  const lines = [
    `Take over ${ref}${lease.title && lease.taskId ? ` "${lease.title}"` : ''}.`,
    `Current owner: ${lease.agent ?? 'unknown'} · session ${lease.session ?? '?'}` +
      (lease.branch ? ` · branch ${lease.branch}` : '') +
      (lease.fenceToken != null ? ` · fence ${lease.fenceToken}` : '') + '.',
    lease.lastRenewedAt ? `Lease last renewed ${lease.lastRenewedAt}.` : '',
    `Read Jay/memory/working-context.md and the task's why/how in tasks.json, then continue per the lease/fencing protocol (claim a higher fence before writing).`,
  ]
  return lines.filter(Boolean).join('\n')
}

/** Work prompt for a queued/next/blocked task. */
export function taskHandoffPrompt(task: MetisPriorityItem): string {
  const goals = task.goals?.length ? ` Goals: ${task.goals.join(', ')}.` : ''
  return [
    `Work ${task.taskId} "${task.title}" (${task.priority}, ${task.state}).${goals}`,
    `Read its why/how in docs/process/state/tasks.json, claim it atomically (/next or scripts/agent-work.py claim-next), then proceed and verify before marking done.`,
  ].join('\n')
}
