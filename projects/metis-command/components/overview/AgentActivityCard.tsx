'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, Radio } from 'lucide-react'
import { StatusCard } from './cards'
import { ageLabel, metisApi } from '@/lib/metis-api'
import { ptyApi } from '@/lib/pty-client'
import { useControlCenterNav } from '@/lib/control-center-nav'
import type { Agent } from '@/lib/types'
import type { MetisLease } from '@/lib/metis-api-types'

// ── Live agent activity (#240 Phase 4) ────────────────────────────────────────
// Cross-workspace heartbeat: merges the PTY sidecar's live agents (claude/codex/
// shell running in this Control Center) with the cross-machine lease ledger (checkouts
// from Jay/Jarry/CLI workers). One glance at who is working on what right now.
// Self-contained polling (15s) + graceful degradation when the sidecar is down.

const AGENT_DOT: Record<string, string> = {
  claude: 'bg-violet-300', codex: 'bg-cyan-300', shell: 'bg-emerald-300',
  gemini: 'bg-amber-300', forge: 'bg-violet-300', scout: 'bg-cyan-300',
  shield: 'bg-rose-300', echo: 'bg-sky-300',
}
const dotFor = (k?: string | null) => AGENT_DOT[(k ?? '').toLowerCase()] ?? 'bg-slate-300'

const STATUS_CLS: Record<string, string> = {
  running: 'text-emerald-300', starting: 'text-amber-300', exited: 'text-slate-500',
}

export default function AgentActivityCard() {
  const nav = useControlCenterNav()
  const [agents, setAgents] = useState<Agent[] | null>(null)
  const [leases, setLeases] = useState<MetisLease[] | null>(null)
  const [ptyDown, setPtyDown] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    // PTY sidecar (may be unreachable in a browser tab without the desktop app).
    try {
      const a = await ptyApi.listAgents({ includeExited: false })
      setAgents(a.agents)
      setPtyDown(false)
    } catch {
      setAgents([])
      setPtyDown(true)
    }
    const r = await metisApi.leases()
    setLeases(r.ok ? r.data.leases : [])
    setNow(Date.now())
  }, [])

  useEffect(() => {
    load()
    timer.current = setInterval(load, 15000)
    return () => { if (timer.current) clearInterval(timer.current) }
  }, [load])

  const live = (agents ?? []).filter((a) => a.status === 'running' || a.status === 'starting')
  // Leases not already represented by a live local PTY agent on the same task →
  // these are the cross-machine / CLI workers (the value a pure PTY list misses).
  const liveTaskIds = new Set(live.map((a) => a.taskId).filter(Boolean))
  const remoteLeases = (leases ?? []).filter((l) => !l.taskId || !liveTaskIds.has(l.taskId))
  const total = live.length + remoteLeases.length
  const severity = total > 0 ? 'ok' : 'warn'

  return (
    <StatusCard
      title="Agent Activity"
      icon={<Activity size={12} className={total > 0 ? 'text-emerald-300' : 'text-[var(--muted)]'} />}
      severity={severity}
      onClick={() => nav.goto('agents')}
      actionHint="Open Agents"
    >
      <div className="flex items-baseline gap-2">
        <span className="text-2xl md:text-xl font-black tabular-nums text-slate-100">{total}</span>
        <span className="text-[12px] md:text-[11px] text-[var(--muted)]">working now · {live.length} here · {remoteLeases.length} remote</span>
      </div>

      {total === 0 ? (
        <div className="mt-2 text-[12px] md:text-[11px] text-[var(--muted)]">
          {ptyDown ? 'PTY sidecar unreachable · showing leases only' : 'No agents working right now.'}
        </div>
      ) : (
        <ul className="mt-2 flex flex-col gap-1">
          {live.slice(0, 5).map((a) => (
            <li key={a.id} className="flex items-center gap-2 text-[12px] md:text-[11px]">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotFor(a.kind)}`} />
              <span className="shrink-0 font-semibold text-slate-200">{a.name}</span>
              {a.taskId && <span className="shrink-0 font-mono text-[var(--muted)]">{a.taskId}</span>}
              <span className={`truncate ${STATUS_CLS[a.status] ?? 'text-slate-400'}`}>{a.status}</span>
              <div className="flex-1" />
              <span className="shrink-0 text-[var(--muted)]">{ageLabel(a.lastOutputAt ?? a.createdAt, now)}</span>
            </li>
          ))}
          {remoteLeases.slice(0, Math.max(0, 6 - live.length)).map((l, i) => (
            <li key={`lease-${l.taskId ?? i}`} className="flex items-center gap-2 text-[12px] md:text-[11px]">
              <Radio size={11} className="shrink-0 text-cyan-300/70" />
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotFor(l.agent)}`} />
              <span className="shrink-0 font-semibold text-slate-300">{l.agent ?? 'agent'}</span>
              {l.taskId && <span className="shrink-0 font-mono text-[var(--muted)]">{l.taskId}</span>}
              <span className="truncate text-[var(--muted)]">{l.title ?? 'checked out'}</span>
              <div className="flex-1" />
              {l.fenceToken != null && <span className="shrink-0 text-[var(--muted)]">·{l.fenceToken}</span>}
            </li>
          ))}
        </ul>
      )}
    </StatusCard>
  )
}
