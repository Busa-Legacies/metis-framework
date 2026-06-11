'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Command, Plus, FolderOpen, LayoutGrid, Trash2, Globe, Megaphone, Settings as Gear, Terminal } from 'lucide-react'
import type { Agent, AgentKind, Workspace } from '@/lib/types'

interface Action {
  id: string
  title: string
  hint?: string
  group: 'spawn' | 'workspace' | 'layout' | 'agent' | 'broadcast' | 'misc'
  icon?: React.ReactNode
  run: () => void | Promise<void>
}

interface Props {
  open: boolean
  onClose: () => void
  workspaces: Workspace[]
  agents: Agent[]
  activeWorkspaceId: string | null
  onSwitchWorkspace: (id: string) => void
  onNewWorkspace: () => void
  onSpawn: (kind: AgentKind, name: string) => void | Promise<void>
  onApplyPreset: (n: number) => void
  onKillAgent: (id: string) => void
  onOpenSettings: () => void
  onBroadcast: (text: string) => void | Promise<void>
}

export default function CommandPalette({
  open, onClose, workspaces, agents, activeWorkspaceId,
  onSwitchWorkspace, onNewWorkspace, onSpawn, onApplyPreset, onKillAgent, onOpenSettings, onBroadcast,
}: Props) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => { if (open) { setQuery(''); setSelected(0); setTimeout(() => inputRef.current?.focus(), 0) } }, [open])

  const wsAgents = agents.filter((a) => a.workspaceId === activeWorkspaceId)

  const allActions: Action[] = useMemo(() => {
    const base: Action[] = []
    base.push(
      { id: 'new-ws', title: 'New workspace', group: 'workspace', icon: <Plus size={12} />, run: onNewWorkspace },
      { id: 'settings', title: 'Open settings', group: 'misc', icon: <Gear size={12} />, run: onOpenSettings },
    )
    workspaces.forEach((w) => base.push({
      id: 'ws-' + w.id,
      title: `Switch to: ${w.name}`,
      hint: w.cwd,
      group: 'workspace',
      icon: <FolderOpen size={12} />,
      run: () => onSwitchWorkspace(w.id),
    }))
    ;(['claude', 'codex', 'shell', 'gemini', 'python'] as AgentKind[]).forEach((k) => base.push({
      id: 'spawn-' + k,
      title: `Spawn ${k}`,
      hint: 'enter to spawn, or type "spawn 2 claude frontend api"',
      group: 'spawn',
      icon: <Terminal size={12} />,
      run: () => onSpawn(k, k),
    }))
    ;[1, 2, 3, 4, 6].forEach((n) => base.push({
      id: 'layout-' + n,
      title: `Layout: ${n === 4 ? '2×2' : n === 6 ? '3×2' : n + ' panes'}`,
      group: 'layout',
      icon: <LayoutGrid size={12} />,
      run: () => onApplyPreset(n),
    }))
    wsAgents.forEach((a) => base.push({
      id: 'kill-' + a.id,
      title: `Kill ${a.name} (${a.kind})`,
      hint: `pid ${a.pid}`,
      group: 'agent',
      icon: <Trash2 size={12} />,
      run: () => onKillAgent(a.id),
    }))
    return base
  }, [workspaces, wsAgents, onSwitchWorkspace, onNewWorkspace, onSpawn, onApplyPreset, onKillAgent, onOpenSettings])

  // Parse inline commands in the query
  const inline: Action[] = useMemo(() => {
    const q = query.trim()
    if (!q) return []
    const out: Action[] = []
    // spawn: "spawn 2 claude a b" or "2 claude a b"
    const spawnMatch = q.match(/^(?:spawn\s+)?(\d+)?\s*(claude|codex|shell|gemini|python)\b\s*(.*)$/i)
    if (spawnMatch) {
      const count = Math.max(1, parseInt(spawnMatch[1] ?? '1', 10))
      const kind = spawnMatch[2].toLowerCase() as AgentKind
      const namesPart = (spawnMatch[3] ?? '').trim()
      const names = namesPart ? namesPart.split(/\s+/) : []
      out.push({
        id: 'inline-spawn',
        title: `Spawn ${count} × ${kind}${names.length ? ` (${names.join(', ')})` : ''}`,
        group: 'spawn',
        icon: <Plus size={12} />,
        run: async () => {
          for (let i = 0; i < count; i++) await onSpawn(kind, names[i] ?? `${kind}-${Date.now().toString(36).slice(-3)}-${i + 1}`)
        },
      })
    }
    // broadcast: "broadcast hello"
    const bcastMatch = q.match(/^(?:broadcast|bc)\s+(.+)$/i)
    if (bcastMatch) {
      const text = bcastMatch[1]
      out.push({
        id: 'inline-broadcast',
        title: `Broadcast: "${text.slice(0, 60)}"`,
        hint: `to all ${wsAgents.length} agents in workspace`,
        group: 'broadcast',
        icon: <Megaphone size={12} />,
        run: () => onBroadcast(text),
      })
    }
    return out
  }, [query, onSpawn, onBroadcast, wsAgents.length])

  const filtered = useMemo(() => {
    const all = [...inline, ...allActions]
    const q = query.trim().toLowerCase()
    if (!q) return all.slice(0, 30)
    return all
      .map((a) => ({ a, score: scoreMatch(`${a.title} ${a.hint ?? ''}`, q) }))
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, 30)
      .map((x) => x.a)
  }, [allActions, inline, query])

  useEffect(() => { setSelected(0) }, [query])

  if (!open) return null

  function execute(action: Action) {
    onClose()
    Promise.resolve(action.run()).catch(() => {})
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 px-4 pt-[12vh] backdrop-blur-sm" onMouseDown={onClose}>
      <div onMouseDown={(e) => e.stopPropagation()} className="w-full max-w-xl rounded-2xl border border-slate-400/20 bg-black/95 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-slate-400/10 px-3 py-2">
          <Command size={14} className="text-cyan-300" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((s) => Math.min(filtered.length - 1, s + 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((s) => Math.max(0, s - 1)) }
              else if (e.key === 'Enter') { e.preventDefault(); const a = filtered[selected]; if (a) execute(a) }
              else if (e.key === 'Escape') { e.preventDefault(); onClose() }
            }}
            placeholder='spawn 2 claude frontend api  ·  layout 2x2  ·  broadcast read README.md  ·  switch to …'
            className="flex-1 bg-transparent text-[13px] text-white placeholder:text-slate-500 focus:outline-none"
          />
          <kbd className="rounded border border-slate-400/20 px-1 text-[10px] text-slate-500">esc</kbd>
        </div>
        <div className="max-h-[55vh] overflow-y-auto p-1 text-[12px]">
          {filtered.length === 0 && <div className="px-3 py-2 text-slate-500">no matches</div>}
          {filtered.map((a, i) => (
            <button
              key={a.id}
              onClick={() => execute(a)}
              onMouseEnter={() => setSelected(i)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${i === selected ? 'bg-cyan-300/10 text-white' : 'text-slate-300 hover:bg-slate-300/5'}`}
            >
              <span className="text-slate-400">{a.icon}</span>
              <span className="flex-1 truncate font-semibold">{a.title}</span>
              {a.hint && <span className="truncate text-[10px] text-slate-500">{a.hint}</span>}
              <span className="ml-2 rounded border border-slate-400/15 px-1 text-[9px] uppercase tracking-[0.16em] text-slate-500">{a.group}</span>
            </button>
          ))}
        </div>
        <div className="border-t border-slate-400/10 px-3 py-1.5 text-[10px] text-slate-500">
          ↑/↓ navigate · ↵ run · esc close
        </div>
      </div>
    </div>
  )
}

function scoreMatch(haystack: string, needle: string): number {
  const h = haystack.toLowerCase()
  if (h.includes(needle)) return 100 - (h.indexOf(needle) || 0)
  // very basic subsequence match
  let hi = 0
  for (let i = 0; i < needle.length; i++) {
    const idx = h.indexOf(needle[i], hi)
    if (idx < 0) return 0
    hi = idx + 1
  }
  return 30
}
