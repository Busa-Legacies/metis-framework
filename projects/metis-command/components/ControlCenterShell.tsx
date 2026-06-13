'use client'

import { useEffect, useState } from 'react'
import { Briefcase } from 'lucide-react'
import { MetisMark } from './ui/MetisMark'
import BootScreen from './ui/BootScreen'
import Workbench from './Workbench'
import OverviewMode from './overview/OverviewMode'
import WorkMode from './work/WorkMode'
import UsageMode from './usage/UsageMode'
import OpsMode from './ops/OpsMode'
import PersonalMode from './personal/PersonalMode'
import SettingsMode from './settings/SettingsMode'
import AnnotateWidget from './annotate/AnnotateWidget'
import NavoreMode, { NavoreOverview } from './example/NavoreMode'
import { NavoreScopeBanner } from './example/example-ui'
import { CONTROL_CENTER_MODES, DEFAULT_MODE, normalizeTopLevelMode, type ControlCenterMode, type ModeId } from '@/lib/control-center-modes'
import { ControlCenterNavProvider, type NavParams } from '@/lib/control-center-nav'
import { WorkspaceProvider, useWorkspace } from '@/lib/workspace-context'
import { workspaceMeta } from '@/lib/workspace'

const STORAGE_KEY = 'metis.Control Center.mode'

const STATUS_DOT: Record<ControlCenterMode['status'], string> = {
  live: 'bg-emerald-300',
  bridge: 'bg-cyan-300',
  planned: 'bg-slate-500',
}

/**
 * Metis Control Center shell (M1). Owns the viewport and top-level mode nav, and
 * re-scopes the whole Control Center between the Personal and Professional (Example)
 * workspaces (PLAN §9.1). The workspace toggle is in Settings; here every mode
 * reads the context and the domain slot swaps Personal ↔ Example.
 */
export default function ControlCenterShell() {
  return (
    <WorkspaceProvider>
      <ControlCenterInner />
    </WorkspaceProvider>
  )
}

function ControlCenterInner() {
  const [mode, setMode] = useState<ModeId>(DEFAULT_MODE)
  const [navParams, setNavParams] = useState<NavParams | null>(null)
  const { workspace } = useWorkspace()
  const meta = workspaceMeta(workspace)
  const pro = workspace === 'professional'

  // Restore last mode after mount (avoids SSR/client hydration mismatch).
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY) as ModeId | null
      if (saved && (CONTROL_CENTER_MODES.some((m) => m.id === saved) || ['inbox', 'work-graph', 'lines', 'tasks', 'review'].includes(saved))) setMode(saved)
    } catch {
      /* localStorage unavailable — keep default */
    }
  }, [])

  const select = (id: ModeId, params?: NavParams) => {
    setMode(id)
    // A plain nav click carries no payload → clear any prior deep-link filter so
    // a goal filter / task focus never leaks across an unrelated navigation.
    setNavParams(params ?? null)
    try {
      window.localStorage.setItem(STORAGE_KEY, id)
    } catch {
      /* ignore */
    }
  }

  // The domain slot (mode id `personal`) carries the workspace label/icon; every
  // other mode keeps its own. Mode ids are stable so localStorage/e2e selectors
  // don't move when the label flips.
  const navLabel = (m: ControlCenterMode) => (m.id === 'personal' ? meta.label : m.label)
  const navIcon = (m: ControlCenterMode) => (m.id === 'personal' && pro ? Briefcase : m.icon)
  const activeTopMode = normalizeTopLevelMode(mode)

  return (
    <ControlCenterNavProvider value={{ goto: select, current: mode, params: navParams }}>
    <BootScreen />
    <div className="grid-bg flex h-screen w-screen flex-col overflow-hidden text-white">
      <div className="flex min-h-0 flex-1">
        {/* Desktop mode rail (vertical) — hidden on mobile */}
        <nav className="tb-drag hidden w-[68px] shrink-0 flex-col items-stretch gap-1 border-r border-[var(--line)] bg-black/25 px-1.5 pb-2 pt-7 md:flex">
          <div className="mb-2 flex flex-col items-center gap-0.5 px-1">
            <MetisMark size={20} />
            <span className="text-center text-[9px] font-black uppercase leading-tight tracking-[0.12em] text-cyan-100">
              Control<br />Center
            </span>
            {/* Workspace indicator (not a toggle — the switch lives in Settings) */}
            <span
              data-testid="workspace-indicator"
              className={`mt-1 rounded-full px-1.5 py-0 text-[9px] font-black uppercase tracking-[0.1em] ${
                pro ? 'bg-amber-300/15 text-amber-200' : 'bg-cyan-300/15 text-cyan-200'
              }`}
            >
              {meta.short}
            </span>
          </div>
          {CONTROL_CENTER_MODES.map((m) => {
            const Icon = navIcon(m)
            const active = m.id === activeTopMode
            const label = navLabel(m)
            return (
              <button
                key={m.id}
                aria-label={label}
                data-testid={`mode-nav-${m.id}`}
                onClick={() => select(m.id)}
                title={`${label} — ${m.description}`}
                className={`group relative flex flex-col items-center gap-0.5 rounded-lg border px-1 py-1.5 text-[9px] font-bold transition-colors ${
                  active
                    ? 'border-cyan-300/50 bg-cyan-300/10 text-cyan-100'
                    : 'border-transparent text-slate-400 hover:bg-white/[0.03] hover:text-slate-200'
                }`}
              >
                <span className={`absolute right-1 top-1 h-1.5 w-1.5 rounded-full ${STATUS_DOT[m.status]}`} />
                <Icon size={16} />
                <span className="leading-none">{label.split(' ')[0]}</span>
              </button>
            )
          })}
        </nav>

        {/* Main content area (plain div, not <main> — Workbench owns the <main> landmark) */}
        <div className="relative min-w-0 flex-1">
          {CONTROL_CENTER_MODES.map((m) => (
            <div key={m.id} className={`absolute inset-0 ${m.id === activeTopMode ? 'block' : 'hidden'}`}>
              {m.id === 'agents' ? (
                pro ? <BannerWrap><Workbench /></BannerWrap> : <Workbench />
              ) : m.id === 'overview' ? (
                pro ? <NavoreOverview /> : <OverviewMode />
              ) : m.id === 'work' ? (
                <WorkMode professional={pro} initialView={mode} />
              ) : m.id === 'usage' ? (
                pro ? (
                  <BannerWrap note="Professional context · Example usage attribution arrives with the Example Claude account link.">
                    <UsageMode />
                  </BannerWrap>
                ) : (
                  <UsageMode />
                )
              ) : m.id === 'ops' ? (
                <OpsMode />
              ) : m.id === 'personal' ? (
                pro ? <NavoreMode /> : <PersonalMode />
              ) : m.id === 'settings' ? (
                <SettingsMode />
              ) : (
                <ModePlaceholder mode={m} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Mobile bottom tab bar — md:hidden. Thumb-reachable (the old top strip
          scrolled the active mode out of view and read as a desktop leftover);
          icon-over-label tabs, ≥44px touch targets, iOS safe-area padding, and
          the active tab auto-scrolls into view on mode change. */}
      <nav className="flex shrink-0 items-stretch overflow-x-auto border-t border-[var(--line)] bg-black/60 backdrop-blur-md pb-[max(env(safe-area-inset-bottom),14px)] md:hidden">
        {CONTROL_CENTER_MODES.map((m) => {
          const Icon = navIcon(m)
          const active = m.id === activeTopMode
          const label = navLabel(m)
          return (
            <button
              key={m.id}
              aria-label={label}
              data-testid={`mode-nav-${m.id}`}
              ref={(el) => { if (active && el) el.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }) }}
              onClick={() => select(m.id)}
              className={`flex min-w-[80px] flex-1 flex-col items-center gap-1 px-2 pb-1 pt-2.5 text-[12px] font-bold uppercase tracking-wide transition-colors ${
                active ? 'text-cyan-200' : 'text-slate-400 active:text-slate-200'
              }`}
            >
              <span className={`flex h-10 w-[60px] items-center justify-center rounded-full ${active ? 'bg-cyan-300/15' : ''}`}>
                <Icon size={24} />
              </span>
              {label.split(' ')[0]}
            </button>
          )
        })}
      </nav>

      {/* Site-wide annotate tool — message Metis about the current page */}
      <AnnotateWidget />
    </div>
    </ControlCenterNavProvider>
  )
}

/** Wraps a shared-infra mode with the Example scope banner (keeps the child's
 *  full-height layout: banner + flex-1 min-h-0 container). */
function BannerWrap({ note, children }: { note?: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col">
      <NavoreScopeBanner note={note} />
      <div className="relative min-h-0 flex-1">{children}</div>
    </div>
  )
}

function ModePlaceholder({ mode }: { mode: ControlCenterMode }) {
  const Icon = mode.icon
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="panel flex h-16 w-16 items-center justify-center rounded-2xl">
        <Icon size={28} className="text-cyan-200" />
      </div>
      <div className="text-[15px] font-black uppercase tracking-[0.18em] text-cyan-100">{mode.label}</div>
      <div className="max-w-md text-[13px] text-slate-300">{mode.description}</div>
      <span className="badge">Planned · {mode.milestone}</span>
      <div className="max-w-sm text-[12px] text-[var(--muted)]">
        This mode lands in a later convergence milestone. Until then, use{' '}
        <span className="text-cyan-200">Agents</span> for command and{' '}
        <span className="text-cyan-200">Overview</span> for the legacy dashboard.
      </div>
    </div>
  )
}
