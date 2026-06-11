/**
 * Shared task-state visual encoding (design-guidelines §6.5 + mobile pass 3).
 * One source for every surface that renders governed-task state: rows encode
 * state as a single colored dot, detail views as a colored word — never
 * repeated chip badges. Used by TaskBoardMode and WorkGraphMode.
 */

export const STATE_BG: Record<string, string> = {
  in_progress: 'bg-emerald-400/15 text-emerald-200 border-emerald-400/30',
  needs_verification: 'bg-amber-400/15 text-amber-200 border-amber-400/30',
  execution_finished: 'bg-cyan-400/15 text-cyan-200 border-cyan-400/30',
  blocked: 'bg-rose-400/15 text-rose-200 border-rose-400/30',
  waiting: 'bg-slate-400/15 text-slate-300 border-slate-400/20',
  accepted: 'bg-indigo-400/15 text-indigo-200 border-indigo-400/30',
  queued: 'bg-slate-400/10 text-slate-400 border-slate-400/15',
  done: 'bg-green-400/15 text-green-200 border-green-400/30',
  failed: 'bg-red-400/15 text-red-300 border-red-400/30',
}

export const STATE_DOT: Record<string, string> = {
  in_progress: 'bg-emerald-300',
  needs_verification: 'bg-amber-300',
  execution_finished: 'bg-cyan-300',
  blocked: 'bg-rose-400',
  waiting: 'bg-slate-400',
  accepted: 'bg-indigo-300',
  queued: 'bg-slate-600',
  done: 'bg-green-300',
  failed: 'bg-red-400',
}

export const STATE_TEXT: Record<string, string> = {
  in_progress: 'text-emerald-300',
  needs_verification: 'text-amber-300',
  execution_finished: 'text-cyan-300',
  blocked: 'text-rose-300',
  waiting: 'text-slate-400',
  accepted: 'text-indigo-300',
  queued: 'text-slate-400',
  done: 'text-green-300',
  failed: 'text-red-400',
}

export function stateDotCls(state: string): string {
  return STATE_DOT[state] ?? 'bg-slate-600'
}

export function stateTextCls(state: string): string {
  return STATE_TEXT[state] ?? 'text-slate-400'
}
