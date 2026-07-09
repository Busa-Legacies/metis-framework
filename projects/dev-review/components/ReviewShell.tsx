'use client'

import { useCallback, useEffect, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { Bot, Eye, MessageSquare, Loader2 } from 'lucide-react'
import PreviewPane from '@/components/PreviewPane'
import AnnotationRail from '@/components/AnnotationRail'
import AgentTerminal from '@/components/AgentTerminal'
import { ptyApi } from '@/lib/pty-client'
import { useReviewStore } from '@/lib/review-store'
import { useAgentRunWatcher } from '@/lib/use-agent-run-watcher'

type Tab = 'preview' | 'annotate' | 'agent'

function useIsMobile() {
  const [mobile, setMobile] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    setMobile(mq.matches)
    const handler = (e: MediaQueryListEvent) => setMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  return mobile
}

export default function ReviewShell() {
  const agentId = useReviewStore((s) => s.agentId)
  const setAgentId = useReviewStore((s) => s.setAgentId)
  const workspaceId = useReviewStore((s) => s.workspaceId)
  const setWorkspaceId = useReviewStore((s) => s.setWorkspaceId)
  const [spawning, setSpawning] = useState(false)
  const [ptyUp, setPtyUp] = useState<boolean | null>(null)
  const [tab, setTab] = useState<Tab>('preview')
  const url = useReviewStore((s) => s.url)
  const hydrate = useReviewStore((s) => s.hydrate)
  const isMobile = useIsMobile()
  // Round-trip verify loop (#258): shell-level so the watch survives mobile tab switches.
  useAgentRunWatcher()

  useEffect(() => {
    ptyApi.health().then(() => setPtyUp(true)).catch(() => setPtyUp(false))
  }, [])

  // Pre-seed from ?targetUrl= so `open "http://localhost:3760/?targetUrl=<encoded>"`
  // drops directly into the review with the target loaded (terminal-to-Metis standard).
  const setUrl = useReviewStore((s) => s.setUrl)
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search)
    const tv = sp.get('targetUrl')
    if (tv) setUrl(decodeURIComponent(tv))
  }, [setUrl])

  useEffect(() => { if (url) void hydrate(url) }, [url, hydrate])

  const spawnAgent = useCallback(async () => {
    setSpawning(true)
    try {
      let wsId = workspaceId
      if (!wsId) {
        const existing = await ptyApi.listWorkspaces()
        wsId = existing.workspaces[0]?.id ?? (await ptyApi.createWorkspace({ name: 'review' })).workspace.id
        setWorkspaceId(wsId)
      }
      const { agent } = await ptyApi.spawnAgent({ workspaceId: wsId, kind: 'claude', name: 'reviewer' })
      setAgentId(agent.id)
    } finally {
      setSpawning(false)
    }
  }, [workspaceId, setWorkspaceId, setAgentId])

  const agentPanel = (
    <div className="flex h-full flex-col">
      <header className={`flex shrink-0 items-center gap-2 border-b bg-[rgba(5,6,10,0.92)] px-3 py-1.5 ${agentId ? 'border-violet-400/15' : 'border-slate-400/10'}`}>
        <Bot size={12} className={agentId ? 'text-violet-300' : 'text-slate-600'} />
        <span className={`text-[10px] font-bold uppercase tracking-[0.18em] ${agentId ? 'text-violet-300' : 'text-slate-500'}`}>
          Agent
        </span>
        {agentId && (
          <>
            <span className="ml-1 font-mono text-[10px] text-slate-600">{agentId.slice(0, 8)}</span>
            <div className="ml-auto h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400" />
          </>
        )}
      </header>
      {agentId ? (
        <div className="scanline relative min-h-0 flex-1 overflow-hidden">
          <AgentTerminal agentId={agentId} />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <button
            onClick={spawnAgent}
            disabled={spawning || ptyUp === false}
            className="flex items-center gap-2 rounded-md border border-violet-400/30 bg-violet-400/10 px-3 py-2 text-xs uppercase tracking-wider text-violet-300 enabled:hover:bg-violet-400/20 disabled:opacity-40"
          >
            {spawning ? <Loader2 size={14} className="animate-spin" /> : <Bot size={14} />}
            spawn claude
          </button>
          <span className="text-[10px] text-slate-500">agent receives annotations as structured prompts</span>
        </div>
      )}
    </div>
  )

  const header = (
    <header className="flex items-center gap-3 border-b border-slate-400/10 bg-[rgba(5,6,10,0.95)] px-4 py-2 shrink-0">
      <span className="text-xs font-black uppercase tracking-[0.22em] text-cyan-100">Dev Review</span>
      <span className="hidden text-[10px] text-slate-500 sm:block">annotate · dispatch · verify</span>
      <div className="flex-1" />
      {agentId && (
        <span className="flex items-center gap-1.5 rounded bg-violet-400/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-violet-300">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400" />
          agent active
        </span>
      )}
      {ptyUp === false && (
        <span className="rounded bg-rose-400/15 px-2 py-0.5 text-[10px] uppercase tracking-wider text-rose-300">
          pty offline
        </span>
      )}
    </header>
  )

  if (isMobile) {
    const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
      { id: 'preview',  label: 'Preview',  icon: <Eye size={16} /> },
      { id: 'annotate', label: 'Annotate', icon: <MessageSquare size={16} /> },
      { id: 'agent',    label: 'Agent',    icon: <Bot size={16} /> },
    ]
    return (
      <div className="grid-bg flex h-[100dvh] flex-col">
        {header}
        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === 'preview'  && <PreviewPane />}
          {tab === 'annotate' && <AnnotationRail />}
          {tab === 'agent'    && agentPanel}
        </div>
        <nav className="flex shrink-0 border-t border-slate-400/10 bg-black/60">
          {TABS.map(({ id, label, icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={[
                'flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] uppercase tracking-wider transition-colors',
                tab === id
                  ? 'text-cyan-300'
                  : 'text-slate-500 hover:text-slate-300',
              ].join(' ')}
            >
              {icon}
              {label}
            </button>
          ))}
        </nav>
      </div>
    )
  }

  return (
    <div className="grid-bg flex h-screen flex-col">
      {header}
      <PanelGroup direction="horizontal" className="flex-1">
        <Panel defaultSize={55} minSize={30}>
          <PreviewPane />
        </Panel>
        <PanelResizeHandle className="w-px bg-slate-400/15 hover:bg-cyan-300/40" />
        <Panel defaultSize={20} minSize={14}>
          <AnnotationRail />
        </Panel>
        <PanelResizeHandle className="w-px bg-slate-400/15 hover:bg-cyan-300/40" />
        <Panel defaultSize={25} minSize={18}>
          {agentPanel}
        </Panel>
      </PanelGroup>
    </div>
  )
}
