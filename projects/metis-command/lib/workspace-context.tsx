'use client'

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { DEFAULT_WORKSPACE, normalizeWorkspace, type Workspace } from './workspace'

/**
 * Live workspace context for the Control Center shell. Holds the Personal ↔
 * Professional(Navore) selection, persisted to localStorage so the Control Center
 * reopens in the last-used context. The toggle UI lives in Settings (PLAN: the
 * single canonical control); every mode reads `workspace` to re-scope itself.
 */

const STORAGE_KEY = 'metis.workspace'

interface WorkspaceCtx {
  workspace: Workspace
  setWorkspace: (w: Workspace) => void
}

const Ctx = createContext<WorkspaceCtx | null>(null)

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [workspace, setWorkspaceState] = useState<Workspace>(DEFAULT_WORKSPACE)

  // Restore after mount (avoids SSR/client hydration mismatch — same pattern as
  // the shell's mode restore).
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY)
      if (saved) setWorkspaceState(normalizeWorkspace(saved))
    } catch {
      /* localStorage unavailable — keep default */
    }
  }, [])

  const setWorkspace = useCallback((w: Workspace) => {
    setWorkspaceState(w)
    try {
      window.localStorage.setItem(STORAGE_KEY, w)
    } catch {
      /* ignore */
    }
  }, [])

  return <Ctx.Provider value={{ workspace, setWorkspace }}>{children}</Ctx.Provider>
}

/** Safe accessor — defaults to Personal (read-only) when used outside the shell. */
export function useWorkspace(): WorkspaceCtx {
  return useContext(Ctx) ?? { workspace: DEFAULT_WORKSPACE, setWorkspace: () => {} }
}
