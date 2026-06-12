'use client'

import { createContext, useContext } from 'react'
import type { ModeId } from './control-center-modes'

/**
 * Cross-mode navigation for the Control Center. Cards use this to implement the
 * observe→act loop (PLAN §8: every action surface jumps from evidence to the
 * place you act on it) — e.g. a stopped-bot card routes to Ops, a usage drain
 * routes to Usage. The shell provides the implementation; cards stay decoupled
 * from how mode state is held.
 *
 * `params` carries an optional deep-link payload alongside the target mode so a
 * card can route INTO a filtered/focused view — e.g. a goal card jumps to the
 * Tasks board pre-filtered to that goal, or a work row opens straight to a
 * single task's detail. The shell clears params on a plain mode switch (a nav
 * click with no payload), so a stale filter never leaks across navigations.
 */
export interface NavParams {
  /** Filter the Tasks board to one goal (id from MetisGoal / priorities.goals). */
  goalId?: string
  /** Human label for the goal filter banner, e.g. "G1 · AI Ecosystem". */
  goalLabel?: string
  /** Open straight to one task's detail slide-over in the Tasks board. */
  taskId?: string
}

export interface ControlCenterNav {
  goto: (mode: ModeId, params?: NavParams) => void
  current: ModeId
  params: NavParams | null
}

const ControlCenterNavContext = createContext<ControlCenterNav | null>(null)

export const ControlCenterNavProvider = ControlCenterNavContext.Provider

/** Safe accessor — returns a no-op nav when used outside the shell (e.g. tests). */
export function useControlCenterNav(): ControlCenterNav {
  return useContext(ControlCenterNavContext) ?? { goto: () => {}, current: 'agents', params: null }
}
