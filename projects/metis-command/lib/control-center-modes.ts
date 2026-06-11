import type { LucideIcon } from 'lucide-react'
import { LayoutDashboard, GitBranch, Bot, Gauge, Server, Settings, HeartPulse } from 'lucide-react'

export type ModeId = 'overview' | 'work' | 'agents' | 'usage' | 'ops' | 'personal' | 'settings' | 'inbox' | 'work-graph' | 'lines' | 'tasks' | 'review'
export type TopLevelModeId = 'overview' | 'work' | 'agents' | 'usage' | 'ops' | 'personal' | 'settings'

/**
 * Status of a Control Center mode in the convergence roadmap.
 * - `live`   — fully built native React surface.
 * - `bridge` — transitional iframe/legacy embed; has a deletion target (M3+).
 * - `planned`— placeholder; native surface arrives in a later milestone.
 */
export type ModeStatus = 'live' | 'bridge' | 'planned'

export interface ControlCenterMode {
  id: TopLevelModeId
  label: string
  icon: LucideIcon
  description: string
  status: ModeStatus
  /** Roadmap milestone that lands (or retires) this surface. */
  milestone: string
}

/**
 * Top-level Control Center navigation — the M1 mode spine.
 * Order is the canonical nav order on desktop rail and mobile strip.
 * See docs/plans/PLAN-metis-control-center-convergence.md §2.
 */
export const CONTROL_CENTER_MODES: ControlCenterMode[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, description: 'System health, alerts, progress, usage drains', status: 'live', milestone: 'live' },
  { id: 'work', label: 'Work', icon: GitBranch, description: 'Big-picture work map with attention, lines, board, and review drilldowns', status: 'live', milestone: 'M5 condensed' },
  { id: 'agents', label: 'Agents', icon: Bot, description: 'Panes, terminals, spawn/steer agents, broadcasts', status: 'live', milestone: 'live' },
  { id: 'usage', label: 'Usage', icon: Gauge, description: 'Claude/Codex/local capacity, reset windows, spend', status: 'live', milestone: 'live' },
  { id: 'ops', label: 'Ops', icon: Server, description: 'Services, trading bot, memory RAG, remote access', status: 'live', milestone: 'live' },
  { id: 'personal', label: 'Personal', icon: HeartPulse, description: 'Finance, budget, portfolio, health, workouts — life-management surface', status: 'live', milestone: 'M6 (retires legacy personal panels)' },
  { id: 'settings', label: 'Settings', icon: Settings, description: 'Integration/auth health, machine routing, action gates', status: 'live', milestone: 'live (read-only)' },
]

/** Opening mode — Agents keeps the existing Workbench as the default surface (no functionality removed). */
export const DEFAULT_MODE: ModeId = 'agents'

export function modeById(id: ModeId): ControlCenterMode {
  return CONTROL_CENTER_MODES.find((m) => m.id === normalizeTopLevelMode(id)) ?? CONTROL_CENTER_MODES[0]
}

export function normalizeTopLevelMode(id: ModeId): TopLevelModeId {
  if (id === 'inbox' || id === 'work-graph' || id === 'lines' || id === 'tasks' || id === 'review') return 'work'
  return id
}
