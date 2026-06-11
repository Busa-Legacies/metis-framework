'use client'

import { useState } from 'react'
import { Megaphone, Send, ChevronDown } from 'lucide-react'
import { ptyApi } from '@/lib/pty-client'
import type { AgentKind } from '@/lib/types'

interface Props {
  workspaceId: string | null
  agentCount: number
  kindCounts: Record<string, number>
}

const KINDS: { id?: AgentKind; label: string }[] = [
  { id: undefined, label: 'all' },
  { id: 'claude', label: 'claude' },
  { id: 'codex', label: 'codex' },
  { id: 'shell', label: 'shells' },
]

export default function BroadcastBar({ workspaceId, agentCount, kindCounts }: Props) {
  const [text, setText] = useState('')
  const [kind, setKind] = useState<AgentKind | undefined>(undefined)
  const [submitNewline, setSubmitNewline] = useState(true)
  const [busy, setBusy] = useState(false)
  const [lastSent, setLastSent] = useState<{ count: number; at: number } | null>(null)

  async function send() {
    if (!workspaceId || !text.trim() || busy) return
    setBusy(true)
    try {
      const payload = submitNewline ? text + '\r' : text
      const r = await ptyApi.broadcast(workspaceId, payload, kind)
      setLastSent({ count: r.count, at: Date.now() })
      setText('')
    } finally { setBusy(false) }
  }

  const target = kind ? `${kindCounts[kind] ?? 0} ${kind}` : `${agentCount} agents`

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-amber-300/15 bg-amber-300/[0.04] px-3 py-1.5 text-xs">
      <Megaphone size={12} className="text-amber-300" />
      <span className="font-bold uppercase tracking-[0.2em] text-amber-200/80">broadcast</span>

      <div className="relative">
        <select
          value={kind ?? ''}
          onChange={(e) => setKind((e.target.value || undefined) as AgentKind | undefined)}
          className="rounded-md border border-slate-400/15 bg-black/40 px-2 py-1 text-[11px] text-slate-200 focus:outline-none"
        >
          {KINDS.map((k) => (
            <option key={k.label} value={k.id ?? ''}>{k.label}</option>
          ))}
        </select>
      </div>

      <span className="text-slate-500">→ {target}</span>

      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') send() }}
        placeholder='type once, send to all (e.g. "read README.md and summarize")'
        className="flex-1 rounded-md border border-slate-400/15 bg-black/40 px-2 py-1 text-xs text-white placeholder:text-slate-500 focus:border-amber-300/40 focus:outline-none"
      />

      <label className="flex items-center gap-1 text-[10px] text-slate-400" title="append newline (submit) when sending">
        <input type="checkbox" checked={submitNewline} onChange={(e) => setSubmitNewline(e.target.checked)} className="h-3 w-3" />
        ↵
      </label>

      <button
        onClick={send}
        disabled={!text.trim() || busy || !workspaceId}
        className="flex items-center gap-1 rounded-md border border-amber-300/30 bg-amber-300/10 px-2 py-1 text-amber-100 hover:bg-amber-300/20 disabled:opacity-40"
      >
        <Send size={12} /> send
      </button>

      {lastSent && Date.now() - lastSent.at < 2500 && (
        <span className="text-[10px] text-emerald-300">→ {lastSent.count} agent(s)</span>
      )}
    </div>
  )
}
