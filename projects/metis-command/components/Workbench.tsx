'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus, X, Pencil, FolderOpen, RefreshCw, Sparkles, Terminal as TermIcon, Zap, ChevronDown, Settings, RotateCcw, History, LayoutGrid, Square, Columns, Rows3, Folder, FolderTree, Trash2, MoreVertical, Command } from 'lucide-react'
import { ptyApi } from '@/lib/pty-client'
import type { Agent, AgentKind, AgentRole, Attachment, LayoutNode, Task, Workspace } from '@/lib/types'
import type { ControlCenterSummaryResponse, ControlCenterWorkspace } from '@/lib/control-center-summary'
import AssistantPanel from './AssistantPanel'
import SettingsDrawer from './SettingsDrawer'
import PaneGrid from './PaneGrid'
import FileTree from './FileTree'
import BroadcastBar from './BroadcastBar'
import CommandPalette from './CommandPalette'
import NotesPanel from './NotesPanel'
import KnowledgePanel from './KnowledgePanel'
import SkillsPanel from './SkillsPanel'
import McpPanel from './McpPanel'
import TasksPanel from './TasksPanel'
import { applyPreset, assignAgent, assignUrl, closeLeaf, detachAgent, ensureLayoutForAgents, leaves, placeAgent, singleLeafLayout, splitLeaf, swapLeaves, updateSizes, findLeaf } from '@/lib/layout'
import { agentStatusLabel, workspaceActivityCounts, workspaceTaskCounts } from '@/lib/workspace-activity'
import { useWorkspace } from '@/lib/workspace-context'
import { accountForWorkspace } from '@/lib/claude-account'

const KIND_COLOR: Record<AgentKind, string> = {
  claude: 'text-violet-200 border-violet-300/40 bg-violet-300/10',
  codex: 'text-cyan-100 border-cyan-300/40 bg-cyan-300/10',
  shell: 'text-emerald-200 border-emerald-300/40 bg-emerald-300/10',
  gemini: 'text-amber-200 border-amber-300/40 bg-amber-300/10',
  python: 'text-sky-200 border-sky-300/40 bg-sky-300/10',
  custom: 'text-slate-200 border-slate-300/40 bg-slate-300/10',
}

function workspaceDisplayName(workspace: Pick<Workspace, 'name'> | null | undefined) {
  return workspace?.name?.trim() || 'temporary workspace'
}

function workspaceCwdLabel(cwd: string) {
  return cwd.replace(/^\/Users\/[^/]+/, '~')
}

function laneLabel(kind: string) {
  if (kind === 'ack_or_clear') return 'ack/clear'
  if (kind === 'read_report') return 'read report'
  return kind
}

function TaskStatusChips({ counts, compact = false }: { counts: ReturnType<typeof workspaceTaskCounts>; compact?: boolean }) {
  if (counts.total === 0) return null
  const chipClass = compact
    ? 'shrink-0 rounded-full px-1.5 py-0 text-[9px] font-black'
    : 'rounded-full px-1.5 py-0 text-[9px] font-bold'
  return (
    <>
      {counts.todo > 0 && <span title="todo tasks" className={`${chipClass} bg-slate-300/10 text-slate-300`}>{counts.todo} {compact ? 'td' : 'todo'}</span>}
      {counts.building > 0 && <span title="tasks currently building" className={`${chipClass} bg-amber-300/15 text-amber-200`}>{counts.building} {compact ? 'bld' : 'build'}</span>}
      {counts.review > 0 && <span title="tasks awaiting review" className={`${chipClass} bg-cyan-300/15 text-cyan-200`}>{counts.review} {compact ? 'rev' : 'review'}</span>}
      {counts.done > 0 && <span title="done tasks" className={`${chipClass} bg-emerald-300/15 text-emerald-200`}>{counts.done} done</span>}
    </>
  )
}

export default function Workbench() {
  const { workspace } = useWorkspace()
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [tasksByWs, setTasksByWs] = useState<Record<string, Task[]>>({})
  const [activeWsId, setActiveWsId] = useState<string | null>(null)
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showSpawn, setShowSpawn] = useState(false)
  const newBtnRef = useRef<HTMLButtonElement | null>(null)
  const [showWsDialog, setShowWsDialog] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [layoutByWs, setLayoutByWs] = useState<Record<string, LayoutNode>>({})
  const [draggingAgentId, setDraggingAgentId] = useState<string | null>(null)
  const [draggingLeafId, setDraggingLeafId] = useState<string | null>(null)
  const [resumeBanner, setResumeBanner] = useState<{ wsId: string; count: number } | null>(null)
  const [leftTab, setLeftTab] = useState<'workspaces' | 'files' | 'tasks'>('workspaces')
  const [maximizedLeafId, setMaximizedLeafId] = useState<string | null>(null)
  const [showPalette, setShowPalette] = useState(false)
  const [rightTab, setRightTab] = useState<'assistant' | 'notes' | 'knowledge' | 'skills' | 'mcp'>('assistant')
  const [showMobileLeft, setShowMobileLeft] = useState(false)
  const [showMobileRight, setShowMobileRight] = useState(false)
  const [showMobileMenu, setShowMobileMenu] = useState(false)
  const [injectedAttachments, setInjectedAttachments] = useState<Attachment[]>([])
  const [editingWsId, setEditingWsId] = useState<string | null>(null)
  const [gitByWs, setGitByWs] = useState<Record<string, { inRepo: boolean; branch?: string | null; dirty?: number; ahead?: number; behind?: number }>>({})
  const [controlCenterSummary, setControlCenterSummary] = useState<ControlCenterSummaryResponse | null>(null)
  const globalRunningCount = agents.filter((a) => a.status === 'running').length
  const globalExitedCount = agents.filter((a) => a.status === 'exited').length
  // ref so async callbacks can read the current agent list without stale closures
  const agentsRef = useRef<Agent[]>([])

  const refresh = useCallback(async () => {
    try {
      const [ws, ag] = await Promise.all([ptyApi.listWorkspaces(), ptyApi.listAgents()])
      const taskEntries = await Promise.all(ws.workspaces.map(async (workspace) => {
        try {
          const result = await ptyApi.listTasks(workspace.id)
          return [workspace.id, result.tasks] as const
        } catch {
          return [workspace.id, []] as const
        }
      }))
      setWorkspaces(ws.workspaces)
      setAgents(ag.agents)
      setTasksByWs(Object.fromEntries(taskEntries))
      setActiveWsId((cur) => cur ?? ws.workspaces[0]?.id ?? null)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to reach pty server (is it running on :3748?)')
    }
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 4000)
    return () => clearInterval(t)
  }, [refresh])

  const refreshControlCenterSummary = useCallback(async () => {
    if (!activeWsId) {
      setControlCenterSummary(null)
      return
    }
    try {
      const qs = new URLSearchParams({
        scope: 'control-center',
        active_workspace_id: activeWsId,
        reports_limit: '5',
      })
      const res = await fetch(`/api/assistant?${qs.toString()}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : res.statusText)
      setControlCenterSummary(data as ControlCenterSummaryResponse)
    } catch {
      setControlCenterSummary(null)
    }
  }, [activeWsId])

  useEffect(() => {
    refreshControlCenterSummary()
    const t = setInterval(refreshControlCenterSummary, 5000)
    return () => clearInterval(t)
  }, [refreshControlCenterSummary])

  // keep ref in sync with agents
  useEffect(() => { agentsRef.current = agents }, [agents])

  // Poll git status for all workspaces (light: ~12s)
  useEffect(() => {
    let alive = true
    async function tick() {
      const next: typeof gitByWs = {}
      for (const w of workspaces) {
        try {
          const s = await ptyApi.gitStatus(w.id)
          next[w.id] = s
        } catch {}
        if (!alive) return
      }
      if (alive) setGitByWs(next)
    }
    tick()
    const t = setInterval(tick, 12_000)
    return () => { alive = false; clearInterval(t) }
  }, [workspaces.map((w) => w.id).join(',')])

  // Keyboard shortcuts: Esc unmaximizes; Cmd/Ctrl+K opens palette; Cmd/Ctrl+1..9 switches workspace
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && maximizedLeafId) setMaximizedLeafId(null)
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault(); setShowPalette((v) => !v)
      }
      if (meta && /^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1
        const w = workspaces[idx]
        if (w) { e.preventDefault(); setActiveWsId(w.id) }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [maximizedLeafId, workspaces])

  // Load + cache layout for active workspace.
  // Merges loaded layout with the current live agents so we don't lose just-spawned agents
  // to a stale (empty) server layout in a race with the wsAgents-effect.
  useEffect(() => {
    if (!activeWsId) return
    if (layoutByWs[activeWsId]) return
    let alive = true
    ptyApi.getLayout(activeWsId).then((d) => {
      if (!alive) return
      const wsId = activeWsId
      const root = (d.layout as LayoutNode | null) ?? singleLeafLayout()
      setLayoutByWs((cur) => {
        if (cur[wsId]) return cur // wsAgents effect already populated; keep it
        const liveIds = agentsRef.current.filter((a) => a.workspaceId === wsId).map((a) => a.id)
        return { ...cur, [wsId]: ensureLayoutForAgents(root, liveIds) }
      })
      setActiveLeafId((prev) => prev ?? leaves(root)[0]?.id ?? null)
    }).catch(() => {
      const wsId = activeWsId
      setLayoutByWs((cur) => {
        if (cur[wsId]) return cur
        const liveIds = agentsRef.current.filter((a) => a.workspaceId === wsId).map((a) => a.id)
        return { ...cur, [wsId]: ensureLayoutForAgents(singleLeafLayout(), liveIds) }
      })
    })
    return () => { alive = false }
  }, [activeWsId, layoutByWs])

  // Detect resume opportunity
  useEffect(() => {
    if (!activeWsId) return
    ptyApi.resumeSpecs(activeWsId).then((d) => {
      const wsAgents = agents.filter((a) => a.workspaceId === activeWsId)
      if (d.specs.length > 0 && wsAgents.length === 0) {
        setResumeBanner({ wsId: activeWsId, count: d.specs.length })
      } else {
        setResumeBanner(null)
      }
    }).catch(() => {})
  }, [activeWsId, agents])

  const wsAgents = useMemo(() => agents.filter((a) => a.workspaceId === activeWsId), [agents, activeWsId])
  const root = activeWsId ? layoutByWs[activeWsId] ?? singleLeafLayout() : singleLeafLayout()
  const activeWs = workspaces.find((w) => w.id === activeWsId) ?? null
  const activeAgentId = useMemo(() => {
    if (!activeLeafId) return null
    const lf = findLeaf(root, activeLeafId)
    return lf?.kind === 'leaf' ? lf.agentId ?? null : null
  }, [root, activeLeafId])
  const activeControlCenterWorkspace = useMemo<ControlCenterWorkspace | null>(() => {
    if (!activeWsId) return null
    return controlCenterSummary?.workspaces.find((workspace) => workspace.workspaceId === activeWsId) ?? null
  }, [activeWsId, controlCenterSummary])

  // Persist layout (debounced) when it changes
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  useEffect(() => {
    if (!activeWsId) return
    const wsId = activeWsId
    if (saveTimers.current[wsId]) clearTimeout(saveTimers.current[wsId])
    saveTimers.current[wsId] = setTimeout(() => {
      delete saveTimers.current[wsId]
      ptyApi.putLayout(wsId, root).catch(() => {})
    }, 350)
  }, [activeWsId, root])

  useEffect(() => () => {
    for (const timer of Object.values(saveTimers.current)) clearTimeout(timer)
    saveTimers.current = {}
  }, [])

  function setRoot(updater: (cur: LayoutNode) => LayoutNode) {
    if (!activeWsId) return
    setLayoutByWs((cur) => ({ ...cur, [activeWsId]: updater(cur[activeWsId] ?? singleLeafLayout()) }))
  }

  // Whenever the live-agent set changes, ensure the layout has a slot for each agent
  // (auto-grows to N panes; rebuilds as a 2x2 grid for 4 agents, etc.)
  useEffect(() => {
    if (!activeWsId) return
    const ids = wsAgents.map((a) => a.id)
    console.log('[wb] wsAgents effect: ws=', activeWsId, 'ids=', ids)
    setRoot((r) => {
      const next = ensureLayoutForAgents(r, ids)
      console.log('[wb] ensureLayoutForAgents: leaves=', next.kind === 'split' ? 'split' : 'leaf', 'json=', JSON.stringify(next).slice(0, 200))
      return next
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsAgents.map((a) => a.id).join(','), activeWsId])

  async function spawn(kind: AgentKind, name: string, cmd?: string, args?: string[], role?: AgentRole, initialPrompt?: string, targetWsId?: string) {
    const wsId = targetWsId ?? activeWsId
    if (!wsId) return
    try {
      await ptyApi.spawnAgent({
        workspaceId: wsId,
        kind,
        name: name.trim() || role || `${kind}`,
        cmd,
        args,
        role,
        initialPrompt: initialPrompt?.trim() || undefined,
        // Professional (Navore) workspace → spawn Claude under the Navore login.
        account: accountForWorkspace(workspace),
      })
      // Spawning into a non-active project switches to it so the new pane is visible
      if (wsId !== activeWsId) setActiveWsId(wsId)
      await refresh()
      // Layout placement happens via the ensureLayoutForAgents effect on wsAgents change.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'spawn failed')
    }
  }

  async function kill(id: string) {
    try { await ptyApi.killAgent(id); await refresh() } catch (e) { setError((e as Error).message) }
  }

  async function rename(id: string, name: string) {
    try { await ptyApi.renameAgent(id, name); await refresh() } catch (e) { setError((e as Error).message) }
  }

  async function createWs(name: string, cwd?: string) {
    try {
      const r = await ptyApi.createWorkspace({
        name: name.trim() || null,
        ...(cwd?.trim() ? { cwd: cwd.trim() } : {}),
      })
      await refresh()
      setActiveWsId(r.workspace.id)
    } catch (e) { setError((e as Error).message) }
  }

  async function deleteWs(id: string) {
    const target = workspaces.find((w) => w.id === id)
    if (!target) return
    if (workspaces.length <= 1) {
      setError('Cannot close the last workspace.')
      return
    }
    const label = workspaceDisplayName(target)
    const cwdLabel = workspaceCwdLabel(target.cwd)
    if (!window.confirm(`Close workspace "${label}"?\n\nThis removes it from Workbench and stops agents in that workspace. Files on disk are not deleted.\n\n${cwdLabel}`)) return
    try {
      await ptyApi.deleteWorkspace(id)
      setLayoutByWs((cur) => {
        const next = { ...cur }
        delete next[id]
        return next
      })
      setGitByWs((cur) => {
        const next = { ...cur }
        delete next[id]
        return next
      })
      setControlCenterSummary(null)
      setActiveWsId((cur) => {
        if (cur !== id) return cur
        return workspaces.find((w) => w.id !== id)?.id ?? null
      })
      await refresh()
    } catch (e) { setError((e as Error).message) }
  }

  async function updateWs(id: string, patch: { name?: string; cwd?: string }) {
    try {
      await ptyApi.updateWorkspace(id, patch)
      await refresh()
    } catch (e) { setError((e as Error).message) }
  }

  async function stopAllInActive() {
    if (!activeWsId) return
    if (!window.confirm('Kill every running agent in this workspace?')) return
    for (const a of wsAgents) if (a.status === 'running') { try { await ptyApi.killAgent(a.id) } catch {} }
    await refresh()
  }

  async function clearGraveyard() {
    if (!activeWsId) return
    try { await ptyApi.clearExitedAgents(activeWsId); await refresh() } catch (e) { setError((e as Error).message) }
  }

  async function resumeWorkspace() {
    if (!activeWsId) return
    try {
      await ptyApi.resumeWorkspace(activeWsId)
      await refresh()
      setRoot((cur) => {
        let next = cur
        // Auto-place new agents into leaves
        const live = new Set(wsAgents.map((a) => a.id))
        // After refresh, agents will populate; the dead-leaf cleanup + spawn handler covers it
        return next
      })
      setResumeBanner(null)
    } catch (e) { setError((e as Error).message) }
  }

  async function dismissResume() {
    if (!activeWsId) return
    await ptyApi.clearResume(activeWsId).catch(() => {})
    setResumeBanner(null)
  }

  async function handleCapturePreview(rect: DOMRect, url: string) {
    const aw = (window as any).aw
    if (!aw?.capturePreview) return
    const dataUrl = await aw.capturePreview({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
    if (!dataUrl) return
    const size = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75)
    const name = `preview-${new URL(url).host}-${Date.now()}.png`
    setInjectedAttachments((p) => [...p, { type: 'image', dataUrl, name, size }])
    setRightTab('assistant')
  }

  function closePane(leafId: string) {
    const lf = findLeaf(root, leafId)
    const agentId = lf?.kind === 'leaf' ? lf.agentId : null
    const agent = agentId ? wsAgents.find((a) => a.id === agentId) : null
    setRoot((r) => closeLeaf(r, leafId))
    if (activeLeafId === leafId) setActiveLeafId(null)
    if (agent?.status === 'exited') void kill(agent.id)
  }

  function openAgentPane(workspaceId: string, agentId: string) {
    setActiveWsId(workspaceId)
    setLayoutByWs((cur) => {
      const rootForWs = cur[workspaceId] ?? singleLeafLayout()
      const existing = leaves(rootForWs).find((l) => l.agentId === agentId)
      if (existing) {
        setActiveLeafId(existing.id)
        return cur
      }
      const placed = placeAgent(rootForWs, agentId, activeLeafId ?? undefined)
      const target = leaves(placed).find((l) => l.agentId === agentId)
      if (target) setActiveLeafId(target.id)
      return { ...cur, [workspaceId]: placed }
    })
  }

  return (
    <div className="grid-bg flex h-full w-full flex-col text-white">
      <header
        className="tb-drag relative z-50 flex items-center gap-2 border-b border-slate-400/10 bg-black/30 py-2 pr-4 pl-4"
      >
        {/* Mobile sidebar toggles */}
        <button
          onClick={() => { setShowMobileLeft((v) => !v); setShowMobileRight(false) }}
          className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-400/15 bg-black/30 text-slate-400 hover:text-white md:hidden"
          title="Workspaces & files"
        >
          <Folder size={20} />
        </button>
        <div className="flex items-center gap-2">
          <Zap size={16} className="text-cyan-300" />
          <div className="hidden text-xs font-black uppercase tracking-[0.22em] text-cyan-100 md:block">Agent Command</div>
        </div>
        <div className="mx-2 hidden h-5 w-px bg-slate-400/15 md:block md:mx-3" />
        <WorkspaceSwitcher
          workspaces={workspaces}
          agents={agents}
          tasksByWs={tasksByWs}
          activeId={activeWsId}
          onSelect={setActiveWsId}
          onNew={() => setShowWsDialog(true)}
          onDelete={deleteWs}
        />
        <div className="flex-1" />
        {(globalRunningCount > 0 || globalExitedCount > 0) && (
          <div
            title="global agent activity across all workspaces"
            className="hidden items-center gap-1 rounded-lg border border-slate-400/15 bg-black/30 px-2 py-1 text-[11px] font-semibold text-slate-300 sm:flex"
          >
            <span className="text-slate-500">agents</span>
            {globalRunningCount > 0 && <span className="rounded-full bg-emerald-300/15 px-1.5 py-0 text-[9px] font-black text-emerald-200">{globalRunningCount} running</span>}
            {globalExitedCount > 0 && <span className="rounded-full bg-amber-300/15 px-1.5 py-0 text-[9px] font-black text-amber-200">{globalExitedCount} exited</span>}
          </div>
        )}
        <button
          onClick={() => setShowPalette(true)}
          title="Command palette"
          className="hidden items-center gap-1.5 rounded-lg border border-slate-400/15 bg-black/30 px-2 py-1 text-[11px] text-slate-400 hover:text-white sm:flex"
        >
          <span>commands</span>
          <kbd className="rounded border border-slate-400/20 bg-black/40 px-1 py-px text-[9px] font-semibold text-slate-300">⌘K</kbd>
        </button>
        {wsAgents.some((a) => a.status === 'running') && (
          <button
            onClick={stopAllInActive}
            title="kill every running agent in this workspace"
            className="flex items-center gap-1 rounded-lg border border-rose-300/30 bg-rose-300/10 px-2 py-1 text-xs text-rose-200 hover:bg-rose-300/20"
          >
            <Square size={12} /> stop all
          </button>
        )}
        {(() => {
          const exitedCount = wsAgents.filter((a) => a.status === 'exited').length
          if (exitedCount === 0) return null
          return (
            <button
              onClick={clearGraveyard}
              title="remove every exited agent's tab and scrollback in this workspace (running agents untouched)"
              className="flex items-center gap-1 rounded-lg border border-slate-400/20 bg-black/30 px-2 py-1 text-xs text-slate-300 hover:border-rose-300/30 hover:text-rose-200"
            >
              <Trash2 size={12} /> clear exited
              <span className="rounded-full bg-rose-300/15 px-1.5 py-0 text-[9px] font-bold text-rose-200">{exitedCount}</span>
            </button>
          )
        })()}
        <button onClick={refresh} className="hidden items-center gap-1 rounded-lg border border-slate-400/15 bg-black/30 px-2 py-1 text-xs text-slate-300 hover:text-white md:flex">
          <RefreshCw size={14} /> refresh
        </button>
        <button onClick={() => setShowSettings(true)} className="hidden items-center gap-1 rounded-lg border border-slate-400/15 bg-black/30 px-2 py-1 text-xs text-slate-300 hover:text-white sm:flex" title="Settings">
          <Settings size={12} /> settings
        </button>
        {/* Mobile overflow menu — surfaces controls hidden on phone (commands / settings / refresh / layout) */}
        <div className="relative md:hidden">
          <button
            onClick={() => setShowMobileMenu((v) => !v)}
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-400/15 bg-black/30 text-slate-400 hover:text-white"
            title="More"
          >
            <MoreVertical size={20} />
          </button>
          {showMobileMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowMobileMenu(false)} />
              <div className="absolute right-0 top-full z-50 mt-1 w-52 rounded-lg border border-slate-400/15 bg-black/95 p-1 shadow-xl backdrop-blur">
                <button onClick={() => { setShowMobileMenu(false); setShowPalette(true) }} className="flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left text-xs text-slate-200 hover:bg-slate-300/10">
                  <Command size={14} className="text-cyan-300" /> Command palette
                </button>
                <button onClick={() => { setShowMobileMenu(false); refresh() }} className="flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left text-xs text-slate-200 hover:bg-slate-300/10">
                  <RefreshCw size={14} className="text-slate-400" /> Refresh
                </button>
                <button onClick={() => { setShowMobileMenu(false); setShowSettings(true) }} className="flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left text-xs text-slate-200 hover:bg-slate-300/10">
                  <Settings size={14} className="text-slate-400" /> Settings
                </button>
                <div className="my-1 border-t border-slate-400/10" />
                <div className="px-3 py-1 text-[9px] font-bold uppercase tracking-[0.18em] text-slate-500">Layout</div>
                <div className="flex flex-wrap gap-1 px-2 pb-1.5">
                  {[{ n: 1, label: '1' }, { n: 2, label: '2' }, { n: 4, label: '2×2' }, { n: 6, label: '3×2' }].map((p) => (
                    <button
                      key={p.n}
                      onClick={() => { setShowMobileMenu(false); setRoot((r) => applyPreset(r, p.n)) }}
                      className="flex items-center gap-1 rounded-md border border-slate-400/15 bg-black/30 px-2.5 py-1.5 text-[11px] text-slate-300 hover:border-cyan-300/40 hover:text-white"
                    >
                      <LayoutGrid size={12} /> {p.label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
        <button
          onClick={() => { setShowMobileRight((v) => !v); setShowMobileLeft(false) }}
          className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-400/15 bg-black/30 text-slate-400 hover:text-cyan-300 md:hidden"
          title="Metis Assistant"
        >
          <Sparkles size={20} />
        </button>
        {error && <div className="rounded-lg border border-rose-300/30 bg-rose-300/10 px-2 py-1 text-[11px] text-rose-200">{error}</div>}
      </header>

      <div className="relative grid flex-1 grid-cols-1 overflow-hidden md:grid-cols-[220px_minmax(0,1fr)_320px] xl:grid-cols-[260px_minmax(0,1fr)_360px]">
        {/* Left rail */}
        <aside className={`flex-col overflow-hidden border-r border-slate-400/10 bg-[#05060a] md:bg-black/20 ${showMobileLeft ? 'fixed inset-y-0 left-0 z-50 flex w-72 border-r' : 'hidden md:flex'}`}>
          <div className="flex items-center gap-1 border-b border-slate-400/10 px-2 py-1.5">
            <button
              onClick={() => setLeftTab('workspaces')}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${leftTab === 'workspaces' ? 'bg-cyan-300/10 text-cyan-200' : 'text-slate-500 hover:text-white'}`}
            >
              <Folder size={12} /> ws
            </button>
            <button
              onClick={() => setLeftTab('files')}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${leftTab === 'files' ? 'bg-cyan-300/10 text-cyan-200' : 'text-slate-500 hover:text-white'}`}
            >
              <FolderTree size={12} /> files
            </button>
            <button
              onClick={() => setLeftTab('tasks')}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${leftTab === 'tasks' ? 'bg-cyan-300/10 text-cyan-200' : 'text-slate-500 hover:text-white'}`}
            >
              <LayoutGrid size={12} /> tasks
            </button>
            <div className="flex-1" />
            <button
              onClick={() => setShowMobileLeft(false)}
              className="flex items-center justify-center rounded-md p-2 text-slate-400 hover:bg-slate-300/10 hover:text-white md:hidden"
              title="Close"
            >
              <X size={14} />
            </button>
            <div className="flex-1" />
            {leftTab === 'workspaces' && (
              <button onClick={() => setShowWsDialog(true)} className="rounded-md border border-slate-400/20 p-1 text-slate-300 hover:text-white" title="new workspace">
                <Plus size={12} />
              </button>
            )}
          </div>
          {leftTab === 'workspaces' ? (
            <>
              <div className="flex-1 space-y-1 overflow-y-auto px-2 py-2">
                {workspaces.map((w) => {
                  const active = w.id === activeWsId
                  const activity = workspaceActivityCounts(agents, w.id)
                  const taskCounts = workspaceTaskCounts(tasksByWs[w.id] ?? [], w.id)
                  const git = gitByWs[w.id]
                  const nextLane = controlCenterSummary?.nextActions.find((action) => action.workspaceId === w.id)
                  return (
                    <div
                      key={w.id}
                      onClick={() => setActiveWsId(w.id)}
                      className={`group flex w-full cursor-pointer flex-col gap-1 rounded-lg border px-2 py-2 text-left text-sm transition ${active ? 'border-cyan-300/40 bg-cyan-300/10 text-white' : 'border-slate-400/10 bg-black/20 text-slate-300 hover:border-slate-400/30 hover:text-white'}`}
                    >
                      <div className="flex items-center gap-2">
                        <FolderOpen size={14} className={active ? 'text-cyan-300' : 'text-slate-500'} />
                        <span className={`flex-1 truncate ${w.name.trim() ? '' : 'italic text-slate-500'}`}>{workspaceDisplayName(w)}</span>
                        {activity.active > 0 && (
                          <span title="active agents in this workspace" className="rounded-full bg-emerald-300/15 px-1.5 py-0 text-[9px] font-bold text-emerald-200">{activity.active} active</span>
                        )}
                        {activity.exited > 0 && (
                          <span title="completed/exited agents retained for review" className="rounded-full bg-amber-300/15 px-1.5 py-0 text-[9px] font-bold text-amber-200">{activity.exited} exited</span>
                        )}
                        {(() => {
                          const ev = controlCenterSummary?.workspaces.find((cw) => cw.workspaceId === w.id)?.evidence.total ?? 0
                          return ev > 0 ? (
                            <span title="evidence rows logged for this workspace" className="rounded-full bg-indigo-300/15 px-1.5 py-0 text-[9px] font-bold text-indigo-200">{ev} ev</span>
                          ) : null
                        })()}
                        <button
                          onClick={(e) => { e.stopPropagation(); setEditingWsId(w.id) }}
                          title="edit"
                          className="rounded p-0.5 text-slate-500 opacity-0 transition group-hover:opacity-100 hover:bg-slate-300/10 hover:text-white"
                        ><Pencil size={12} /></button>
                        <button
                          onClick={(e) => { e.stopPropagation(); void deleteWs(w.id) }}
                          disabled={workspaces.length <= 1}
                          title={workspaces.length <= 1 ? 'cannot close the last workspace' : 'close workspace'}
                          className="rounded p-0.5 text-slate-500 opacity-0 transition group-hover:opacity-100 hover:bg-rose-300/20 hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-20 disabled:hover:bg-transparent disabled:hover:text-slate-500"
                        ><X size={12} /></button>
                      </div>
                      <div className="truncate text-[10px] text-slate-500" title={w.cwd}>
                        {workspaceCwdLabel(w.cwd)}
                      </div>
                      {taskCounts.total > 0 && (
                        <div className="flex flex-wrap items-center gap-1 text-[10px]" title="task status in this workspace">
                          <span className="text-slate-500">tasks</span>
                          <TaskStatusChips counts={taskCounts} />
                        </div>
                      )}
                      {nextLane && (
                        <div className="flex items-start gap-1 rounded border border-cyan-300/15 bg-cyan-300/[0.04] px-1.5 py-1 text-[10px] leading-snug text-slate-300" title={nextLane.reason}>
                          <span className="shrink-0 font-bold uppercase tracking-[0.12em] text-cyan-200">{laneLabel(nextLane.kind)}</span>
                          <span className="min-w-0 truncate text-slate-400">{nextLane.reason}</span>
                        </div>
                      )}
                      {git?.inRepo && (
                        <div className="flex items-center gap-1 truncate text-[10px] text-slate-500">
                          <span className="text-cyan-300/80">⎇ {git.branch ?? 'detached'}</span>
                          {git.dirty ? <span className="text-amber-300">· {git.dirty} ✱</span> : <span className="text-emerald-300/80">· clean</span>}
                          {git.ahead ? <span className="text-cyan-300">· ↑{git.ahead}</span> : null}
                          {git.behind ? <span className="text-rose-300">· ↓{git.behind}</span> : null}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              <div className="border-t border-slate-400/10 px-3 py-2 text-[10px] text-slate-500">
                cwd: <span className="text-slate-300">{activeWs?.cwd ?? '—'}</span>
              </div>
            </>
          ) : leftTab === 'files' ? (
            <FileTree
              workspaceId={activeWsId}
              workspaceCwd={activeWs?.cwd ?? ''}
              onPickFile={async (absPath, _rel) => {
                const lf = activeLeafId ? findLeaf(root, activeLeafId) : null
                const aid = lf?.kind === 'leaf' ? lf.agentId : null
                const quoted = /^[A-Za-z0-9._\/\-]+$/.test(absPath) ? absPath : `'${absPath.replace(/'/g, `'\\''`)}'`
                if (aid) {
                  try { await ptyApi.sendInput(aid, quoted + ' ') } catch {}
                } else {
                  try { await navigator.clipboard.writeText(absPath) } catch {}
                }
              }}
            />
          ) : (
            <TasksPanel workspaceId={activeWsId} agents={wsAgents} onError={(m) => setError(m)} />
          )}
        </aside>

        {/* Main */}
        <main className="flex flex-col overflow-hidden">
          <div className="flex items-stretch border-b border-slate-400/10 bg-black/20">
            {/* Scrollable agent tabs (caps height; tabs scroll, controls below stay visible) */}
            <div className="flex flex-1 flex-wrap items-center gap-1 px-2 py-1.5 max-h-[88px] overflow-y-auto min-w-0">
              {wsAgents.map((a) => (
                <AgentTab
                  key={a.id}
                  agent={a}
                  isActive={a.id === activeAgentId}
                  onClick={() => {
                    if (activeLeafId) setRoot((r) => assignAgent(r, activeLeafId, a.id))
                  }}
                  onKill={() => kill(a.id)}
                  onRename={(n) => rename(a.id, n)}
                  onDragStart={() => setDraggingAgentId(a.id)}
                  onDragEnd={() => setDraggingAgentId(null)}
                />
              ))}
              {wsAgents.length === 0 && (
                <div className="ml-1 min-w-0 overflow-hidden text-xs text-slate-500 truncate">
                  <span className="sm:hidden">no agents — tap <span className="text-cyan-200">spawn</span></span>
                  <span className="hidden sm:inline">no agents — click <span className="text-cyan-200">spawn</span> →, use operator, or resume</span>
                </div>
              )}
            </div>

            {/* Pinned: + new button (always visible regardless of how many tabs accumulate) */}
            <div className="flex shrink-0 items-center gap-1 border-l border-slate-400/15 px-2 py-1.5">
              <button
                ref={newBtnRef}
                onClick={() => setShowSpawn((v) => !v)}
                className="flex items-center gap-1 rounded-lg border border-cyan-300/30 bg-cyan-300/10 px-3 py-2.5 text-sm md:px-2.5 md:py-1.5 md:text-xs text-cyan-100 hover:bg-cyan-300/20"
              >
                <Plus size={14} /> spawn
                <ChevronDown size={12} />
              </button>
              {showSpawn && (
                <SpawnMenu
                  anchorRef={newBtnRef}
                  workspaces={workspaces}
                  activeWsId={activeWsId}
                  onClose={() => setShowSpawn(false)}
                  onPick={async (kind, name, role, initialPrompt, wsId) => { setShowSpawn(false); await spawn(kind, name, undefined, undefined, role, initialPrompt, wsId) }}
                />
              )}
            </div>

            {/* Pinned: layout presets */}
            <div className="hidden shrink-0 items-center gap-1 border-l border-slate-400/15 px-2 py-1.5 lg:flex" title="layout presets">
              <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-slate-500">layout</span>
              {[
                { n: 1, label: '1', icon: <Square size={12} /> },
                { n: 2, label: '2', icon: <Columns size={12} /> },
                { n: 4, label: '2×2', icon: <LayoutGrid size={12} /> },
                { n: 6, label: '3×2', icon: <LayoutGrid size={12} /> },
                { n: 8, label: '4×2', icon: <LayoutGrid size={12} /> },
                { n: 9, label: '3×3', icon: <LayoutGrid size={12} /> },
                { n: 12, label: '4×3', icon: <LayoutGrid size={12} /> },
                { n: 16, label: '4×4', icon: <LayoutGrid size={12} /> },
              ].map((p) => (
                <button
                  key={p.n}
                  onClick={() => setRoot((r) => applyPreset(r, p.n))}
                  className="flex items-center gap-1 rounded-md border border-slate-400/15 bg-black/30 px-1.5 py-0.5 text-[10px] text-slate-300 hover:border-cyan-300/40 hover:text-white"
                  title={`apply ${p.label} layout`}
                >
                  {p.icon} {p.label}
                </button>
              ))}
            </div>
          </div>

          {resumeBanner && resumeBanner.wsId === activeWsId && (
            <div className="flex items-center gap-3 border-b border-amber-300/20 bg-amber-300/5 px-3 py-2 text-xs">
              <History size={14} className="text-amber-300" />
              <span className="text-amber-100">
                Pick up where you left off? <span className="text-amber-300">{resumeBanner.count}</span> agent(s) from the last session in this workspace.
                <span className="ml-2 text-amber-100/70">Clear exited removes dead tabs; dismiss forgets this resume list.</span>
              </span>
              <div className="flex-1" />
              <button onClick={resumeWorkspace} className="flex items-center gap-1 rounded-md border border-amber-300/30 bg-amber-300/10 px-3 py-2.5 text-sm md:px-2 md:py-1 md:text-xs text-amber-200 hover:bg-amber-300/20">
                <RotateCcw size={12} /> resume
              </button>
              <button onClick={dismissResume} className="rounded-md border border-slate-400/20 bg-black/30 px-3 py-2.5 text-sm md:px-2 md:py-1 md:text-xs text-slate-300 hover:text-white">dismiss</button>
            </div>
          )}

          {wsAgents.length > 0 && (
            <BroadcastBar
              workspaceId={activeWsId}
              agentCount={wsAgents.length}
              kindCounts={wsAgents.reduce<Record<string, number>>((acc, a) => { acc[a.kind] = (acc[a.kind] ?? 0) + 1; return acc }, {})}
            />
          )}

          <div className="relative flex-1 overflow-hidden p-2">
            <PaneGrid
              root={root}
              agents={wsAgents}
              controlCenterWorkspace={activeControlCenterWorkspace}
              activeLeafId={activeLeafId}
              maximizedLeafId={maximizedLeafId}
              onToggleMaximize={(id) => setMaximizedLeafId((cur) => (cur === id ? null : id))}
              onActivateLeaf={setActiveLeafId}
              onSplit={(leafId, dir) => setRoot((r) => splitLeaf(r, leafId, dir))}
              onClosePane={closePane}
              onAssignAgent={(leafId, agentId) => setRoot((r) => assignAgent(r, leafId, agentId))}
              onAssignUrl={(leafId, url) => setRoot((r) => assignUrl(r, leafId, url))}
              onCapturePreview={handleCapturePreview}
              onSwapLeaves={(a, b) => setRoot((r) => swapLeaves(r, a, b))}
              onResize={(splitId, sizes) => setRoot((r) => updateSizes(r, splitId, sizes))}
              onKillAgent={kill}
              onRenameAgent={rename}
              draggingAgentId={draggingAgentId}
              setDraggingAgentId={setDraggingAgentId}
              draggingLeafId={draggingLeafId}
              setDraggingLeafId={setDraggingLeafId}
            />
          </div>
        </main>

        {/* Right rail: operator context */}
        <aside className={`flex-col overflow-hidden border-l border-slate-400/10 bg-[#05060a] md:bg-black/30 ${showMobileRight ? 'fixed inset-y-0 right-0 z-50 flex w-80' : 'hidden md:flex'}`}>
          <div className="flex items-center gap-1 overflow-x-auto border-b border-slate-400/10 px-2 py-1.5">
            <button
              onClick={() => setShowMobileRight(false)}
              className="flex shrink-0 items-center justify-center rounded-md p-2 text-slate-400 hover:bg-slate-300/10 hover:text-white md:hidden"
              title="Close"
            >
              <X size={14} />
            </button>
            <button
              onClick={() => setRightTab('assistant')}
              className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${rightTab === 'assistant' ? 'bg-cyan-300/10 text-cyan-200' : 'text-slate-500 hover:text-white'}`}
            >assistant</button>
            <button
              onClick={() => setRightTab('notes')}
              className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${rightTab === 'notes' ? 'bg-cyan-300/10 text-cyan-200' : 'text-slate-500 hover:text-white'}`}
            >notes</button>
            <button
              onClick={() => setRightTab('knowledge')}
              className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${rightTab === 'knowledge' ? 'bg-cyan-300/10 text-cyan-200' : 'text-slate-500 hover:text-white'}`}
            >knowledge</button>
            <button
              onClick={() => setRightTab('skills')}
              className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${rightTab === 'skills' ? 'bg-cyan-300/10 text-cyan-200' : 'text-slate-500 hover:text-white'}`}
            >skills</button>
            <button
              onClick={() => setRightTab('mcp')}
              className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${rightTab === 'mcp' ? 'bg-cyan-300/10 text-cyan-200' : 'text-slate-500 hover:text-white'}`}
            >mcp</button>
          </div>
          <div className="flex-1 overflow-hidden">
            {rightTab === 'assistant' ? (
              <AssistantPanel
                activeWorkspaceId={activeWsId}
                onAfterTurn={refresh}
                onOpenAgent={openAgentPane}
                injectedAttachments={injectedAttachments}
                onInjectedConsumed={() => setInjectedAttachments([])}
              />
            ) : rightTab === 'notes' ? (
              <NotesPanel workspaceId={activeWsId} workspaceName={activeWs?.name ?? '—'} />
            ) : rightTab === 'knowledge' ? (
              <KnowledgePanel workspaceId={activeWsId} workspaceName={activeWs?.name ?? '—'} />
            ) : rightTab === 'skills' ? (
              <SkillsPanel workspaceId={activeWsId} workspaceName={activeWs?.name ?? '—'} />
            ) : (
              <McpPanel workspaceId={activeWsId} workspaceName={activeWs?.name ?? '—'} />
            )}
          </div>
        </aside>
      </div>

      {/* Mobile drawer backdrop */}
      {(showMobileLeft || showMobileRight) && (
        <div
          className="fixed inset-0 z-40 bg-black/70 md:hidden"
          onClick={() => { setShowMobileLeft(false); setShowMobileRight(false) }}
        />
      )}

      {showWsDialog && (
        <WorkspaceDialog onClose={() => setShowWsDialog(false)} onCreate={(name, cwd) => { createWs(name, cwd); setShowWsDialog(false) }} />
      )}

      {editingWsId && (() => {
        const ws = workspaces.find((w) => w.id === editingWsId)
        if (!ws) { setEditingWsId(null); return null }
        return (
          <WorkspaceEditDialog
            workspace={ws}
            onClose={() => setEditingWsId(null)}
            onSave={(patch) => { updateWs(editingWsId, patch); setEditingWsId(null) }}
          />
        )
      })()}

      <SettingsDrawer
        open={showSettings}
        onClose={() => setShowSettings(false)}
        activeWorkspaceId={activeWsId}
        onSpawnLogin={async (kind, name, cmd, args) => { await spawn(kind, name, cmd, args) }}
      />

      <CommandPalette
        open={showPalette}
        onClose={() => setShowPalette(false)}
        workspaces={workspaces}
        agents={agents}
        activeWorkspaceId={activeWsId}
        onSwitchWorkspace={setActiveWsId}
        onNewWorkspace={() => setShowWsDialog(true)}
        onSpawn={(kind, name) => spawn(kind, name)}
        onApplyPreset={(n) => setRoot((r) => applyPreset(r, n))}
        onKillAgent={kill}
        onOpenSettings={() => setShowSettings(true)}
        onBroadcast={async (text) => { if (activeWsId) await ptyApi.broadcast(activeWsId, text + '\r') }}
      />
    </div>
  )
}

function AgentTab({ agent, isActive, onClick, onKill, onRename, onDragStart, onDragEnd }: {
  agent: Agent
  isActive?: boolean
  onClick: () => void
  onKill: () => void
  onRename: (n: string) => void
  onDragStart: () => void
  onDragEnd: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [val, setVal] = useState(agent.name)
  // Activity classification (mirrors PaneAgentLabel)
  const lastMs = agent.lastOutputAt ? Date.now() - new Date(agent.lastOutputAt).getTime() : Infinity
  let dotClass = 'bg-slate-500'
  if (agent.status === 'exited') dotClass = 'bg-rose-400'
  else if (agent.status === 'starting') dotClass = 'bg-amber-300 pulse-dot'
  else if (lastMs < 1500) dotClass = 'bg-emerald-300 pulse-dot'
  else if (lastMs < 15_000) dotClass = 'bg-cyan-300 pulse-dot'
  else if (lastMs < 120_000) dotClass = 'bg-slate-300'
  const statusLabel = agentStatusLabel(agent)

  const tabClasses = [
    'group flex shrink-0 cursor-grab items-center gap-2 rounded-lg border px-2.5 py-2.5 text-sm md:py-1.5 md:text-xs transition-all',
    'max-w-[260px]',
    isActive
      ? 'border-cyan-300/50 bg-cyan-300/10 text-white shadow-[0_0_10px_rgba(52,211,255,0.18)]'
      : 'border-slate-400/15 bg-black/30 text-slate-300 hover:text-white hover:border-slate-400/30',
    agent.status === 'exited' ? 'opacity-60' : '',
  ].join(' ')

  return (
    <div
      draggable
      onDragStart={(e) => { onDragStart(); e.dataTransfer.effectAllowed = 'move' }}
      onDragEnd={onDragEnd}
      onClick={onClick}
      className={tabClasses}
      title={[
        `${agent.name} · ${agent.kind}${agent.role ? ` · ${agent.role}` : ''} · ${statusLabel}`,
        agent.lastOutput ? `last: ${agent.lastOutput}` : '',
        'click: drop into active pane · drag: assign · dbl-click name: rename',
      ].filter(Boolean).join('\n')}
    >
      <span className={`badge shrink-0 px-1.5 py-0 text-[9px] ${KIND_COLOR[agent.kind]}`}>{agent.kind}</span>
      {agent.role && (
        <span className="badge shrink-0 border-cyan-300/30 bg-cyan-300/10 px-1 py-0 text-[9px] uppercase tracking-wider text-cyan-200" title={`role: ${agent.role}`}>{agent.role.slice(0,3)}</span>
      )}
      {renaming ? (
        <input
          autoFocus value={val} onChange={(e) => setVal(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={() => { if (val.trim() && val !== agent.name) onRename(val.trim()); setRenaming(false) }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setRenaming(false); setVal(agent.name) } }}
          className="w-28 shrink-0 rounded bg-black/40 px-1 text-xs text-white focus:outline-none"
        />
      ) : (
        <span
          onDoubleClick={(e) => { e.stopPropagation(); setRenaming(true); setVal(agent.name) }}
          className="min-w-0 truncate font-semibold"
        >{agent.name}</span>
      )}
      <span className={`shrink-0 h-1.5 w-1.5 rounded-full ${dotClass}`} title={agent.status} />
      <span
        className={`shrink-0 rounded-full px-1.5 py-0 text-[9px] font-bold ${agent.status === 'exited' ? 'bg-amber-300/15 text-amber-200' : agent.status === 'starting' ? 'bg-amber-300/15 text-amber-200' : 'bg-emerald-300/15 text-emerald-200'}`}
        title={`agent status: ${statusLabel}`}
      >
        {statusLabel}
      </span>
      <button onClick={(e) => { e.stopPropagation(); setRenaming(true); setVal(agent.name) }} className="shrink-0 p-2 opacity-50 hover:opacity-100 md:p-0" title="rename"><Pencil size={12} /></button>
      <button onClick={(e) => { e.stopPropagation(); onKill() }} className="shrink-0 rounded p-2 text-slate-400 hover:bg-rose-300/20 hover:text-rose-200 md:p-0.5" title="kill"><X size={12} /></button>
    </div>
  )
}

function WorkspaceSwitcher({ workspaces, agents, tasksByWs, activeId, onSelect, onNew, onDelete }: {
  workspaces: Workspace[]
  agents: Agent[]
  tasksByWs: Record<string, Task[]>
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const active = workspaces.find((w) => w.id === activeId)
  const activeActivity = active ? workspaceActivityCounts(agents, active.id) : null
  const activeTaskCounts = active ? workspaceTaskCounts(tasksByWs[active.id] ?? [], active.id) : null
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    function place() {
      const a = btnRef.current
      if (!a) return
      const r = a.getBoundingClientRect()
      const width = 256 // w-64
      const margin = 8
      let left = r.left
      if (left + width > window.innerWidth - margin) left = window.innerWidth - width - margin
      if (left < margin) left = margin
      setPos({ top: r.bottom + 4, left })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (popRef.current?.contains(t)) return
      if (btnRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="relative">
      <button ref={btnRef} onClick={() => setOpen((v) => !v)} className="flex items-center gap-2 rounded-lg border border-slate-400/15 bg-black/40 px-2.5 py-2.5 text-sm md:px-2 md:py-1 md:text-xs text-slate-200 hover:text-white">
        <FolderOpen size={12} className="text-cyan-300" />
        <span className={`font-semibold ${active && !active.name.trim() ? 'italic text-slate-400' : ''}`}>{active ? workspaceDisplayName(active) : 'no workspace'}</span>
        {activeActivity && activeActivity.active > 0 && (
          <span title="active agents in selected workspace" className="rounded-full bg-emerald-300/15 px-1.5 py-0 text-[9px] font-black text-emerald-200">{activeActivity.active} active</span>
        )}
        {activeActivity && activeActivity.exited > 0 && (
          <span title="exited agents retained in selected workspace" className="rounded-full bg-amber-300/15 px-1.5 py-0 text-[9px] font-black text-amber-200">{activeActivity.exited} exited</span>
        )}
        {activeTaskCounts && activeTaskCounts.active > 0 && (
          <span title="open tasks in selected workspace" className="rounded-full bg-cyan-300/15 px-1.5 py-0 text-[9px] font-black text-cyan-200">{activeTaskCounts.active} open tasks</span>
        )}
        <ChevronDown size={12} />
      </button>
      {open && pos && typeof document !== 'undefined' && createPortal(
        <div
          ref={popRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 1000 }}
          className="w-64 rounded-lg border border-slate-400/15 bg-black/95 p-1 shadow-lg backdrop-blur"
        >
          {workspaces.map((w) => {
            const activity = workspaceActivityCounts(agents, w.id)
            const taskCounts = workspaceTaskCounts(tasksByWs[w.id] ?? [], w.id)
            return (
            <div key={w.id} className={`group flex items-center gap-1 rounded-md ${w.id === activeId ? 'bg-cyan-300/10 text-cyan-100' : 'text-slate-200 hover:bg-slate-300/10'}`}>
              <button onClick={() => { onSelect(w.id); setOpen(false) }} className="flex min-w-0 flex-1 items-center justify-between gap-2 px-2 py-1.5 text-left text-xs">
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className={`min-w-0 truncate font-semibold ${w.name.trim() ? '' : 'italic text-slate-500'}`}>{workspaceDisplayName(w)}</span>
                  {activity.active > 0 && <span title="active agents" className="shrink-0 rounded-full bg-emerald-300/15 px-1.5 py-0 text-[9px] font-black text-emerald-200">{activity.active} active</span>}
                  {activity.exited > 0 && <span title="exited agents" className="shrink-0 rounded-full bg-amber-300/15 px-1.5 py-0 text-[9px] font-black text-amber-200">{activity.exited} exited</span>}
                  <TaskStatusChips counts={taskCounts} compact />
                </span>
                <span className="max-w-[84px] truncate text-[10px] text-slate-500">{workspaceCwdLabel(w.cwd)}</span>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); void onDelete(w.id); setOpen(false) }}
                disabled={workspaces.length <= 1}
                title={workspaces.length <= 1 ? 'cannot close the last workspace' : 'close workspace'}
                className="mr-1 rounded p-0.5 text-slate-500 opacity-0 transition group-hover:opacity-100 hover:bg-rose-300/20 hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-20 disabled:hover:bg-transparent disabled:hover:text-slate-500"
              >
                <X size={12} />
              </button>
            </div>
          )})}
          <div className="my-1 h-px bg-slate-400/10" />
          <button onClick={() => { setOpen(false); onNew() }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-cyan-200 hover:bg-cyan-300/10">
            <Plus size={12} /> new workspace
          </button>
        </div>,
        document.body,
      )}
    </div>
  )
}

const ROLE_DESC: Record<AgentRole, string> = {
  builder: 'implements; touches only declared files',
  reviewer: 'reads diff; blocks substandard work',
  scout: 'read-only research; reports findings',
  coordinator: 'decomposes; assigns; tracks status',
}

function SpawnMenu({ anchorRef, workspaces, activeWsId, onClose, onPick }: { anchorRef: React.RefObject<HTMLElement | null>; workspaces: Workspace[]; activeWsId: string | null; onClose: () => void; onPick: (kind: AgentKind, name: string, role?: AgentRole, initialPrompt?: string, wsId?: string) => void }) {
  const [kind, setKind] = useState<AgentKind>('claude')
  const [role, setRole] = useState<AgentRole | null>(null)
  const [name, setName] = useState('')
  const [directive, setDirective] = useState('')
  const [wsId, setWsId] = useState<string | null>(activeWsId)
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    function place() {
      const a = anchorRef.current
      if (!a) return
      const r = a.getBoundingClientRect()
      const width = 320
      const margin = 8
      let left = r.right - width
      if (left < margin) left = margin
      if (left + width > window.innerWidth - margin) left = window.innerWidth - width - margin
      setPos({ top: r.bottom + 4, left })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchorRef])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t)) return
      if (anchorRef.current?.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose, anchorRef])

  if (typeof document === 'undefined' || !pos) return null

  const roleSupportsKind = kind === 'claude'
  const supportsDirective = kind === 'claude' || kind === 'codex'

  return createPortal(
    <div
      ref={ref}
      style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 1000, width: 320 }}
      className="rounded-lg border border-slate-400/15 bg-black/95 p-3 shadow-2xl backdrop-blur"
    >
      <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">Spawn lane</div>

      <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-500">project</div>
      <select
        value={wsId ?? ''}
        onChange={(e) => setWsId(e.target.value || null)}
        className="mb-2 w-full appearance-none rounded-md border border-slate-400/15 bg-black/40 px-2 py-1.5 text-xs text-white focus:border-cyan-300/40 focus:outline-none"
      >
        {workspaces.map((w) => (
          <option key={w.id} value={w.id} className="bg-black text-white">
            {workspaceDisplayName(w)} — {workspaceCwdLabel(w.cwd)}{w.id === activeWsId ? ' (current)' : ''}
          </option>
        ))}
      </select>

      <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-500">role (claude only)</div>
      <div className="mb-2 grid grid-cols-4 gap-1">
        {([null, 'builder', 'reviewer', 'scout', 'coordinator'] as Array<AgentRole | null>).slice(1).map((r) => (
          <button
            key={r}
            onClick={() => setRole(role === r ? null : r)}
            disabled={!roleSupportsKind}
            title={r ? ROLE_DESC[r] : ''}
            className={`rounded-md border px-1 py-1 text-[10px] transition ${role === r ? 'border-cyan-300/50 bg-cyan-300/15 text-cyan-100' : 'border-slate-400/15 bg-black/30 text-slate-300 hover:text-white'} ${!roleSupportsKind ? 'opacity-40' : ''}`}
          >
            {r}
          </button>
        ))}
      </div>
      {role && roleSupportsKind && (
        <div className="mb-2 rounded border border-cyan-300/15 bg-cyan-300/[0.04] px-2 py-1 text-[10px] text-cyan-200/80">{ROLE_DESC[role]}</div>
      )}

      <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-500">kind</div>
      <div className="mb-2 grid grid-cols-3 gap-1">
        {(['claude', 'codex', 'shell', 'gemini', 'python', 'custom'] as AgentKind[]).map((k) => (
          <button key={k} onClick={() => { setKind(k); if (k !== 'claude') setRole(null) }} className={`rounded-md border px-2 py-1 text-xs transition ${kind === k ? KIND_COLOR[k] : 'border-slate-400/15 bg-black/30 text-slate-300 hover:text-white'}`}>{k}</button>
        ))}
      </div>
      <input
        autoFocus placeholder={role ? `name (default: ${role})` : 'tab name (e.g. frontend, api, deploy)'} value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onPick(kind, name || (role ?? ''), role ?? undefined, directive, wsId ?? undefined) }}
        className="mb-2 w-full rounded-md border border-slate-400/15 bg-black/40 px-2 py-1.5 text-sm text-white placeholder:text-slate-500 focus:border-cyan-300/40 focus:outline-none"
      />
      <div className="mb-1 flex items-center justify-between">
        <label className="text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-500">directive</label>
        {!supportsDirective && <span className="text-[9px] text-slate-600">manual panes ignore this</span>}
      </div>
      <textarea
        value={directive}
        onChange={(e) => setDirective(e.target.value)}
        disabled={!supportsDirective}
        placeholder={kind === 'codex' ? 'Codex exec prompt: goal, files, tests, done signal' : 'Claude appended system prompt: role brief, scope, constraints'}
        className="mb-2 h-24 w-full resize-none rounded-md border border-slate-400/15 bg-black/40 px-2 py-1.5 text-xs leading-relaxed text-white placeholder:text-slate-600 focus:border-cyan-300/40 focus:outline-none disabled:opacity-40"
      />
      <button onClick={() => onPick(kind, name || (role ?? ''), role ?? undefined, directive, wsId ?? undefined)} className="flex w-full items-center justify-center gap-2 rounded-md border border-cyan-300/30 bg-cyan-300/10 py-1.5 text-sm text-cyan-100 hover:bg-cyan-300/20">
        <Sparkles size={12} /> spawn {role ? `${role} ${kind}` : kind}
      </button>
    </div>,
    document.body,
  )
}

function WorkspaceDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, cwd: string) => void }) {
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState('')
  const cwdTrimmed = cwd.trim()
  const inferredName = cwdTrimmed ? cwdTrimmed.replace(/\/+$/, '').split('/').filter(Boolean).pop() : ''
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-slate-400/20 bg-black/90 p-5 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-3 text-sm font-bold uppercase tracking-[0.2em] text-cyan-200/85">New workspace</div>
        <label className="mb-2 block text-[11px] uppercase tracking-[0.18em] text-slate-400">Name</label>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={inferredName ? `blank uses ${inferredName}` : 'optional'} className="mb-1 w-full rounded-md border border-slate-400/15 bg-black/40 px-2 py-1.5 text-sm text-white focus:border-cyan-300/40 focus:outline-none" />
        <div className="mb-3 text-[10px] text-slate-500">Leave blank to create a temporary workspace; choosing a cwd names it from the folder.</div>
        <label className="mb-2 block text-[11px] uppercase tracking-[0.18em] text-slate-400">Working directory</label>
        <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="${METIS_HOME}/projects/foo" className="mb-4 w-full rounded-md border border-slate-400/15 bg-black/40 px-2 py-1.5 text-sm text-white focus:border-cyan-300/40 focus:outline-none" />
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md border border-slate-400/15 px-3 py-1.5 text-xs text-slate-300 hover:text-white">Cancel</button>
          <button onClick={() => onCreate(name.trim(), cwdTrimmed)} className="rounded-md border border-cyan-300/30 bg-cyan-300/10 px-3 py-1.5 text-xs text-cyan-100 hover:bg-cyan-300/20">Create</button>
        </div>
      </div>
    </div>
  )
}

function WorkspaceEditDialog({ workspace, onClose, onSave }: { workspace: Workspace; onClose: () => void; onSave: (patch: { name?: string; cwd?: string }) => void }) {
  const [name, setName] = useState(workspace.name)
  const [cwd, setCwd] = useState(workspace.cwd)
  const dirty = name.trim() !== workspace.name || cwd.trim() !== workspace.cwd
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-slate-400/20 bg-black/90 p-5 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-1 text-sm font-bold uppercase tracking-[0.2em] text-cyan-200/85">Edit workspace</div>
        <div className="mb-3 text-[10px] text-slate-500">id: {workspace.id}</div>
        <label className="mb-2 block text-[11px] uppercase tracking-[0.18em] text-slate-400">Name</label>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="mb-3 w-full rounded-md border border-slate-400/15 bg-black/40 px-2 py-1.5 text-sm text-white focus:border-cyan-300/40 focus:outline-none" />
        <label className="mb-2 block text-[11px] uppercase tracking-[0.18em] text-slate-400">Working directory (cwd)</label>
        <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="${METIS_HOME}/projects/foo" className="mb-1 w-full rounded-md border border-slate-400/15 bg-black/40 px-2 py-1.5 text-sm text-white focus:border-cyan-300/40 focus:outline-none" />
        <div className="mb-4 text-[10px] text-slate-500">Tilde (~/...) is expanded automatically. New agents spawned in this workspace will use this path.</div>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md border border-slate-400/15 px-3 py-1.5 text-xs text-slate-300 hover:text-white">Cancel</button>
          <button
            onClick={() => {
              if (!dirty) { onClose(); return }
              const patch: { name?: string; cwd?: string } = {}
              if (name.trim() !== workspace.name && name.trim()) patch.name = name.trim()
              if (cwd.trim() !== workspace.cwd && cwd.trim()) patch.cwd = cwd.trim()
              onSave(patch)
            }}
            disabled={!dirty}
            className="rounded-md border border-cyan-300/30 bg-cyan-300/10 px-3 py-1.5 text-xs text-cyan-100 hover:bg-cyan-300/20 disabled:opacity-40"
          >Save</button>
        </div>
      </div>
    </div>
  )
}
