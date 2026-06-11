'use client'

import { createContext, useContext } from 'react'
import type { ModeId } from './control-center-modes'

/**
 * Cross-mode navigation for the Control Center. Cards use this to implement the
 * observe→act loop (PLAN §8: every action surface jumps from evidence to the
 * place you act on it) — e.g. a stopped-bot card routes to Ops, a usage drain
 * routes to Usage. The shell provides the implementation; cards stay decoupled
 * from how mode state is held.
 */
export interface ControlCenterNav {
  goto: (mode: ModeId) => void
  current: ModeId
}

const ControlCenterNavContext = createContext<ControlCenterNav | null>(null)

export const ControlCenterNavProvider = ControlCenterNavContext.Provider

/** Safe accessor — returns a no-op nav when used outside the shell (e.g. tests). */
export function useControlCenterNav(): ControlCenterNav {
  return useContext(ControlCenterNavContext) ?? { goto: () => {}, current: 'agents' }
}
