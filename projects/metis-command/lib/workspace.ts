/**
 * Workspace context model (PLAN §9.1 — projects/workspaces as first-class app
 * structure). The Control Center re-scopes the whole Control Center between two
 * operator contexts:
 *
 *   - `personal`      — Ant's life-management surface (finance, health, …).
 *   - `professional`  — the Navore Market workspace (ops, projects, comms).
 *
 * Pure + framework-free so it is unit-testable and importable from the React
 * provider, the shell, and the Settings toggle without a circular client dep.
 * The live React state lives in `workspace-context.tsx`.
 */

export type Workspace = 'personal' | 'professional'

export interface WorkspaceMeta {
  id: Workspace
  /** Nav/domain-slot label and product name in this context. */
  label: string
  /** Short chip text for the workspace indicator. */
  short: string
  /** One-line description of what this context surfaces. */
  blurb: string
  /** Accent token for the workspace indicator (Control Center cyan vs Navore amber). */
  accent: 'cyan' | 'amber'
}

export const WORKSPACES: Record<Workspace, WorkspaceMeta> = {
  personal: {
    id: 'personal',
    label: 'Personal',
    short: 'Personal',
    blurb: 'Life-management: finance, budget, portfolio, health, workouts.',
    accent: 'cyan',
  },
  professional: {
    id: 'professional',
    label: 'Navore',
    short: 'Navore',
    blurb: 'Professional workspace — Navore Market ops, projects, milestones, comms.',
    accent: 'amber',
  },
}

export const DEFAULT_WORKSPACE: Workspace = 'personal'

/** Coerce any persisted/string value to a known Workspace (defaults personal). */
export function normalizeWorkspace(v: string | null | undefined): Workspace {
  return v === 'professional' ? 'professional' : 'personal'
}

/** The other context — for a single-button toggle / "switch to …" affordance. */
export function otherWorkspace(w: Workspace): Workspace {
  return w === 'personal' ? 'professional' : 'personal'
}

export function workspaceMeta(w: Workspace): WorkspaceMeta {
  return WORKSPACES[w]
}

export function isProfessional(w: Workspace): boolean {
  return w === 'professional'
}
