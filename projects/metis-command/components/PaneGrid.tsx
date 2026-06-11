'use client'

import dynamic from 'next/dynamic'
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelGroupHandle } from 'react-resizable-panels'
import { useEffect, useRef, useState } from 'react'
import { ColumnsIcon, RowsIcon, X, Pencil, Globe, Maximize2, Minimize2, MoreVertical, Plus } from 'lucide-react'
import type { Agent, AgentKind, LayoutNode } from '@/lib/types'
import type { ControlCenterWorkspace } from '@/lib/control-center-summary'
import { controlCenterPaneStates, type ControlCenterPaneStateKind } from '@/lib/control-center-ui-state'
import { leaves } from '@/lib/layout'
import { MetisMark } from '@/components/ui/MetisMark'
import BrowserPane from './BrowserPane'

/** True on phone-width viewports (<768px). Drives the single-pane + tab-switcher mobile model. */
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const update = () => setMobile(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return mobile
}

const PANE_KIND_BADGE: Record<AgentKind, string> = {
  claude: 'border-violet-300/40 bg-violet-300/10 text-violet-100',
  codex: 'border-cyan-300/40 bg-cyan-300/10 text-cyan-100',
  shell: 'border-emerald-300/40 bg-emerald-300/10 text-emerald-100',
  gemini: 'border-amber-300/40 bg-amber-300/10 text-amber-100',
  python: 'border-sky-300/40 bg-sky-300/10 text-sky-100',
  custom: 'border-slate-300/40 bg-slate-300/10 text-slate-100',
}

const AgentTerminal = dynamic(() => import('./AgentTerminal'), { ssr: false })

interface Props {
  root: LayoutNode
  agents: Agent[]
  controlCenterWorkspace?: ControlCenterWorkspace | null
  activeLeafId: string | null
  maximizedLeafId: string | null
  onActivateLeaf: (leafId: string) => void
  onSplit: (leafId: string, dir: 'horizontal' | 'vertical') => void
  onClosePane: (leafId: string) => void
  onAssignAgent: (leafId: string, agentId: string | null) => void
  onAssignUrl: (leafId: string, url: string | null) => void
  onCapturePreview?: (rect: DOMRect, url: string) => void
  onSwapLeaves: (aId: string, bId: string) => void
  onResize: (splitId: string, sizes: number[]) => void
  onKillAgent: (id: string) => void
  onRenameAgent: (id: string, name: string) => void
  onToggleMaximize: (leafId: string) => void
  draggingAgentId: string | null
  setDraggingAgentId: (id: string | null) => void
  draggingLeafId: string | null
  setDraggingLeafId: (id: string | null) => void
}

export default function PaneGrid(props: Props) {
  const isMobile = useIsMobile()
  // Mobile: never tile. Show one full-screen pane + a tab strip to switch between panes.
  // The underlying split tree is preserved untouched so desktop tiling is unaffected.
  if (isMobile) return <MobilePaneView {...props} />
  // Maximized: render only that leaf full-size
  if (props.maximizedLeafId) {
    const findLeaf = (n: LayoutNode): Extract<LayoutNode, { kind: 'leaf' }> | null => {
      if (n.kind === 'leaf') return n.id === props.maximizedLeafId ? n : null
      for (const c of n.children) { const f = findLeaf(c); if (f) return f }
      return null
    }
    const lf = findLeaf(props.root)
    if (lf) return <LeafView leaf={lf} {...props} />
  }
  return <NodeView {...props} node={props.root} />
}

/** Phone layout: a horizontal pane-tab strip + the single active leaf full-screen. */
function MobilePaneView(props: Props) {
  const all = leaves(props.root)
  const activeId = props.activeLeafId && all.some((l) => l.id === props.activeLeafId)
    ? props.activeLeafId
    : all[0]?.id ?? null
  const activeLeaf = all.find((l) => l.id === activeId) ?? all[0]
  if (!activeLeaf) return null
  return (
    <div className="flex h-full w-full flex-col gap-1.5">
      {all.length > 1 && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto pb-1">
          {all.map((l, i) => {
            const ag = l.kind === 'leaf' && l.agentId ? props.agents.find((a) => a.id === l.agentId) : undefined
            const label = ag ? ag.name : l.kind === 'leaf' && l.url ? 'browser' : `pane ${i + 1}`
            const on = l.id === activeId
            return (
              <button
                key={l.id}
                onClick={() => props.onActivateLeaf(l.id)}
                className={`flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-semibold ${on ? 'border-cyan-300/50 bg-cyan-300/10 text-cyan-100' : 'border-slate-400/15 bg-black/30 text-slate-400'}`}
              >
                {ag && <span className={`rounded border px-1 py-0 text-[9px] uppercase ${PANE_KIND_BADGE[ag.kind]}`}>{ag.kind}</span>}
                <span className="max-w-[100px] truncate">{label}</span>
              </button>
            )
          })}
          <button
            onClick={() => props.onSplit(activeLeaf.id, 'vertical')}
            title="add pane"
            className="flex shrink-0 items-center justify-center rounded-md border border-slate-400/15 bg-black/30 p-2 text-slate-400 hover:text-cyan-300"
          >
            <Plus size={14} />
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <LeafView leaf={activeLeaf} {...props} />
      </div>
    </div>
  )
}

function NodeView({ node, ...rest }: Props & { node: LayoutNode }) {
  if (node.kind === 'leaf') return <LeafView leaf={node} {...rest} />
  return <SplitView node={node} {...rest} />
}

function SplitView({ node, ...rest }: Props & { node: Extract<LayoutNode, { kind: 'split' }> }) {
  const ref = useRef<ImperativePanelGroupHandle | null>(null)
  return (
    <PanelGroup
      ref={ref}
      direction={node.dir}
      autoSaveId={node.id}
      onLayout={(sizes) => rest.onResize(node.id, sizes)}
      className="h-full w-full"
    >
      {node.children.map((child, i) => (
        <PanelHolder key={child.id} child={child} index={i} total={node.children.length} defaultSize={node.sizes[i] ?? 100 / node.children.length} dir={node.dir} {...rest} />
      ))}
    </PanelGroup>
  )
}

function PanelHolder({ child, index, total, defaultSize, dir, ...rest }: Props & { child: LayoutNode; index: number; total: number; defaultSize: number; dir: 'horizontal' | 'vertical' }) {
  return (
    <>
      <Panel defaultSize={defaultSize} minSize={10}>
        <NodeView node={child} {...rest} />
      </Panel>
      {index < total - 1 && (
        <PanelResizeHandle className={dir === 'horizontal' ? 'w-1 bg-slate-400/10 hover:bg-cyan-300/30 transition-colors' : 'h-1 bg-slate-400/10 hover:bg-cyan-300/30 transition-colors'} />
      )}
    </>
  )
}

function LeafView({ leaf, agents, controlCenterWorkspace, activeLeafId, maximizedLeafId, onActivateLeaf, onSplit, onClosePane, onAssignAgent, onAssignUrl, onCapturePreview, onSwapLeaves, onKillAgent, onRenameAgent, onToggleMaximize, draggingAgentId, setDraggingAgentId, draggingLeafId, setDraggingLeafId }: Props & { leaf: Extract<LayoutNode, { kind: 'leaf' }> }) {
  const isMaxed = maximizedLeafId === leaf.id
  const agent = leaf.agentId ? agents.find((a) => a.id === leaf.agentId) : undefined
  const active = leaf.id === activeLeafId
  const isBrowser = !!leaf.url
  const empty = !agent && !isBrowser
  const [dragOverKind, setDragOverKind] = useState<null | 'agent' | 'pane'>(null)
  const closeTitle = agent
    ? agent.status === 'exited'
      ? 'clear exited agent and close pane'
      : 'close pane; agent keeps running in tabs'
    : 'close pane'

  const incomingPane = draggingLeafId && draggingLeafId !== leaf.id
  const incomingAgent = !!draggingAgentId
  const paneStates = controlCenterPaneStates(controlCenterWorkspace, agent?.id)

  const ringClass = dragOverKind
    ? 'border-cyan-300/80 ring-1 ring-cyan-300/50 shadow-[0_0_22px_rgba(52,211,255,0.18)]'
    : active
      ? 'border-cyan-300/60 ring-1 ring-cyan-300/30 shadow-[0_0_18px_rgba(52,211,255,0.10)]'
      : 'border-slate-400/15 hover:border-slate-400/30'

  return (
    <div
      onClick={() => onActivateLeaf(leaf.id)}
      onDragOver={(e) => {
        if (incomingAgent) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragOverKind !== 'agent') setDragOverKind('agent') }
        else if (incomingPane) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragOverKind !== 'pane') setDragOverKind('pane') }
      }}
      onDragLeave={() => { if (dragOverKind) setDragOverKind(null) }}
      onDrop={(e) => {
        const k = dragOverKind
        setDragOverKind(null)
        if (incomingAgent && draggingAgentId) {
          e.preventDefault()
          onAssignAgent(leaf.id, draggingAgentId)
          setDraggingAgentId(null)
          return
        }
        if (incomingPane && draggingLeafId) {
          e.preventDefault()
          onSwapLeaves(draggingLeafId, leaf.id)
          setDraggingLeafId(null)
          return
        }
      }}
      className={`relative flex h-full w-full flex-col overflow-hidden rounded-lg border bg-black/40 transition-all ${ringClass}`}
    >
      <header
        draggable={!empty}
        onDragStart={(e) => {
          if (empty) return
          e.stopPropagation()
          setDraggingLeafId(leaf.id)
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/x-aw-leaf', leaf.id)
        }}
        onDragEnd={() => setDraggingLeafId(null)}
        className={`flex items-center gap-1.5 border-b border-slate-400/10 px-1.5 py-1 text-[12px] ${active ? 'bg-cyan-300/[0.04]' : 'bg-black/30'} ${empty ? '' : 'cursor-grab active:cursor-grabbing'}`}
        title={empty ? '' : 'drag header to swap with another pane'}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {agent ? (
            <PaneAgentLabel agent={agent} onKill={onKillAgent} onRename={onRenameAgent} />
          ) : isBrowser ? (
            <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-cyan-100"><Globe size={12} className="shrink-0" /> <span className="shrink-0 font-semibold">browser</span> <span className="truncate text-slate-500">{leaf.url}</span></span>
          ) : (
            <span className="truncate text-slate-500">empty pane — drag a tab here</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {paneStates.map((state) => (
            <span key={state.kind} className={`rounded border px-1 py-0 text-[9px] font-semibold ${paneStateTone(state.kind)}`} title={state.label}>
              {state.label}
            </span>
          ))}
          {empty && <EmptyActions leafId={leaf.id} onAssignUrl={onAssignUrl} />}
          {/* Desktop: full icon row */}
          <div className="hidden items-center gap-0.5 md:flex">
            <button onClick={(e) => { e.stopPropagation(); onToggleMaximize(leaf.id) }} title={isMaxed ? 'restore (esc)' : 'maximize'} className="rounded p-1 text-slate-400 hover:bg-slate-300/10 hover:text-white">
              {isMaxed ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
            </button>
            <button onClick={(e) => { e.stopPropagation(); onSplit(leaf.id, 'horizontal') }} title="split right" className="rounded p-1 text-slate-400 hover:bg-slate-300/10 hover:text-white"><ColumnsIcon size={12} /></button>
            <button onClick={(e) => { e.stopPropagation(); onSplit(leaf.id, 'vertical') }} title="split down" className="rounded p-1 text-slate-400 hover:bg-slate-300/10 hover:text-white"><RowsIcon size={12} /></button>
            <button onClick={(e) => { e.stopPropagation(); onClosePane(leaf.id) }} title={closeTitle} className="rounded p-1 text-slate-400 hover:bg-rose-300/20 hover:text-rose-200"><X size={12} /></button>
          </div>
          {/* Mobile: consolidated kebab menu (44px target, top-right popover) */}
          <PaneKebab
            isMaxed={isMaxed}
            closeTitle={closeTitle}
            onRename={agent ? () => { const n = window.prompt('Rename agent:', agent.name); if (n && n.trim()) onRenameAgent(agent.id, n.trim()) } : undefined}
            onToggleMaximize={() => onToggleMaximize(leaf.id)}
            onSplitDown={() => onSplit(leaf.id, 'vertical')}
            onClose={() => onClosePane(leaf.id)}
          />
        </div>
      </header>
      {dragOverKind && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-cyan-300/[0.06]">
          <span className="rounded-md border border-cyan-300/40 bg-black/70 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-100">
            {dragOverKind === 'pane' ? 'drop to swap' : 'drop to assign'}
          </span>
        </div>
      )}
      <div className="relative flex-1 overflow-hidden">
        {agent ? (
          <AgentTerminal key={agent.id} agentId={agent.id} />
        ) : isBrowser ? (
          <BrowserPane
            url={leaf.url!}
            onChangeUrl={(u) => onAssignUrl(leaf.id, u)}
            onClose={() => onAssignUrl(leaf.id, null)}
            onCapture={onCapturePreview ? (rect) => onCapturePreview(rect, leaf.url!) : undefined}
          />
        ) : (
          <EmptyDrop leafId={leaf.id} onAssignUrl={onAssignUrl} />
        )}
      </div>
    </div>
  )
}

function EmptyActions({ leafId, onAssignUrl }: { leafId: string; onAssignUrl: (id: string, url: string | null) => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); const u = window.prompt('Open URL in this pane:', 'http://localhost:3000'); if (u) onAssignUrl(leafId, u) }}
      title="open browser in this pane"
      className="rounded p-3.5 text-slate-400 hover:text-cyan-200 md:p-1"
    >
      <Globe size={14} />
    </button>
  )
}

/** Mobile per-pane overflow menu — consolidates rename/maximize/split/close into a touch popover. */
function PaneKebab({ isMaxed, closeTitle, onRename, onToggleMaximize, onSplitDown, onClose }: {
  isMaxed: boolean
  closeTitle: string
  onRename?: () => void
  onToggleMaximize: () => void
  onSplitDown: () => void
  onClose: () => void
}) {
  const [open, setOpen] = useState(false)
  const item = 'flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left text-[12px] text-slate-200 hover:bg-slate-300/10'
  return (
    <div className="relative md:hidden">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
        title="pane menu"
        className="flex h-11 w-11 items-center justify-center rounded text-slate-400 hover:bg-slate-300/10 hover:text-white"
      >
        <MoreVertical size={20} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setOpen(false) }} />
          <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-lg border border-slate-400/15 bg-black/95 p-1 shadow-xl backdrop-blur" onClick={(e) => e.stopPropagation()}>
            {onRename && (
              <button className={item} onClick={() => { setOpen(false); onRename() }}>
                <Pencil size={14} className="text-slate-400" /> Rename
              </button>
            )}
            <button className={item} onClick={() => { setOpen(false); onToggleMaximize() }}>
              {isMaxed ? <Minimize2 size={14} className="text-slate-400" /> : <Maximize2 size={14} className="text-slate-400" />} {isMaxed ? 'Restore' : 'Maximize'}
            </button>
            <button className={item} onClick={() => { setOpen(false); onSplitDown() }}>
              <Plus size={14} className="text-slate-400" /> Add pane
            </button>
            <button className={`${item} hover:bg-rose-300/10 hover:text-rose-200`} onClick={() => { setOpen(false); onClose() }} title={closeTitle}>
              <X size={14} /> Close pane
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function PaneAgentLabel({ agent, onKill, onRename }: { agent: Agent; onKill: (id: string) => void; onRename: (id: string, name: string) => void }) {
  const { label, dot } = classifyActivity(agent)
  // Tight, scale-resilient layout: kind badge (always), tiny status dot (always), name (truncates).
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      <span className={`shrink-0 rounded border px-1 py-0 text-[9px] font-bold uppercase ${PANE_KIND_BADGE[agent.kind]}`}>
        {agent.kind}
      </span>
      <span
        className={`shrink-0 h-2 w-2 rounded-full ${dot}`}
        title={agent.status === 'exited' ? `exited code=${agent.exitCode ?? '—'}` : `${label}${agent.pid ? ' · pid ' + agent.pid : ''}`}
      />
      <span className="truncate font-semibold text-white" title={agent.name}>{agent.name}</span>
    </span>
  )
}

function paneStateTone(kind: ControlCenterPaneStateKind): string {
  if (kind === 'stale') return 'border-amber-300/40 bg-amber-300/10 text-amber-200'
  if (kind === 'report-ready') return 'border-sky-300/35 bg-sky-300/10 text-sky-200'
  return 'border-emerald-300/30 bg-emerald-300/10 text-emerald-200'
}

function classifyActivity(agent: Agent): { label: string; dot: string; ring: string; text: string } {
  if (agent.status === 'exited') {
    return { label: 'dead', dot: 'bg-rose-400', ring: 'border-rose-300/30 bg-rose-300/5', text: 'text-rose-200' }
  }
  if (agent.status === 'starting') {
    return { label: 'starting', dot: 'bg-amber-300 pulse-dot', ring: 'border-amber-300/30 bg-amber-300/5', text: 'text-amber-200' }
  }
  const lastMs = agent.lastOutputAt ? Date.now() - new Date(agent.lastOutputAt).getTime() : Infinity
  if (lastMs < 1500) return { label: 'live', dot: 'bg-emerald-300 pulse-dot', ring: 'border-emerald-300/30 bg-emerald-300/5', text: 'text-emerald-200' }
  if (lastMs < 15_000) return { label: 'working', dot: 'bg-cyan-300 pulse-dot', ring: 'border-cyan-300/30 bg-cyan-300/5', text: 'text-cyan-200' }
  if (lastMs < 120_000) return { label: 'idle', dot: 'bg-slate-300', ring: 'border-slate-300/20 bg-slate-300/5', text: 'text-slate-300' }
  return { label: 'silent', dot: 'bg-slate-500', ring: 'border-slate-400/20 bg-slate-400/5', text: 'text-slate-400' }
}

function EmptyDrop({ leafId, onAssignUrl }: { leafId: string; onAssignUrl: (id: string, url: string | null) => void }) {
  return (
    <div className="mc-in flex h-full w-full flex-col items-center justify-center gap-3 overflow-hidden p-4 text-[12px] text-slate-500">
      <MetisMark size={28} className="opacity-50" />
      <p className="w-full text-center text-[13px] font-semibold tracking-wide text-slate-400">No agent in this pane</p>
      <p className="w-full text-center">
        <span className="md:hidden">tap <span className="text-cyan-200">spawn</span> to start an agent</span>
        <span className="hidden md:inline">drop a tab here, or click <span className="text-cyan-200">spawn</span> in the top bar</span>
      </p>
      <button
        onClick={(e) => { e.stopPropagation(); const u = window.prompt('Open URL in this pane:', 'http://localhost:3000'); if (u) onAssignUrl(leafId, u) }}
        className="flex items-center gap-1 rounded-md border border-cyan-300/30 bg-cyan-300/10 px-3 py-2.5 text-[13px] md:px-2.5 md:py-1 md:text-[12px] text-cyan-100 hover:bg-cyan-300/20"
      >
        <Globe size={12} /> open browser preview
      </button>
    </div>
  )
}
