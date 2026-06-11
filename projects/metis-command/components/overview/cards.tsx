'use client'

import { useState } from 'react'
import { ChevronRight, Copy, Check, RefreshCw } from 'lucide-react'
import type { Severity } from '@/lib/metis-api'

/**
 * Shared Control Center card design system (PLAN §7.4 — locked before broad
 * card porting so panels stay visually consistent and don't need a later
 * cleanup rewrite). Single source for the severity tokens, card shell, status
 * chips/dots/meters, and the empty/error/loading/stale states every ported
 * card must handle.
 *
 * ControlCenter accent is cyan (#34d3ff); severity maps to emerald/amber/rose.
 */

export const SEV_TEXT: Record<Severity, string> = {
  ok: 'text-emerald-200',
  warn: 'text-amber-200',
  critical: 'text-rose-200',
}
export const SEV_BAR: Record<Severity, string> = {
  ok: 'bg-emerald-300',
  warn: 'bg-amber-300',
  critical: 'bg-rose-300',
}
export const SEV_DOT: Record<Severity, string> = {
  ok: 'bg-emerald-300',
  warn: 'bg-amber-300',
  critical: 'bg-rose-300',
}

/** Coerce an arbitrary alert-level string to a Severity band. */
export function levelToSeverity(level: string): Severity {
  if (level === 'critical') return 'critical'
  if (level.startsWith('warn')) return 'warn'
  return 'ok'
}

interface StatusCardProps {
  title: string
  icon: React.ReactNode
  severity?: Severity
  /** When set, the card becomes an action surface that routes into a mode. */
  onClick?: () => void
  /** Accessible/hover hint for the action (e.g. "Open Ops"). */
  actionHint?: string
  children: React.ReactNode
}

export function StatusCard({ title, icon, severity, onClick, actionHint, children }: StatusCardProps) {
  const interactive = typeof onClick === 'function'
  const Tag = interactive ? 'button' : 'div'
  return (
    <Tag
      {...(interactive ? { onClick, title: actionHint, type: 'button' as const } : {})}
      className={`panel group flex flex-col gap-2 rounded-xl p-3 text-left ${
        interactive ? 'cursor-pointer transition-colors hover:border-cyan-300/40' : ''
      }`}
    >
      <div className="flex items-center gap-1.5 text-[13px] md:text-[10px] font-black uppercase tracking-[0.18em] text-cyan-200">
        {icon}
        <span>{title}</span>
        {severity && severity !== 'ok' && <span className={`h-1.5 w-1.5 rounded-full ${SEV_DOT[severity]}`} />}
        {interactive && (
          <ChevronRight size={12} className="ml-auto text-slate-500 transition-colors group-hover:text-cyan-200" />
        )}
      </div>
      {children}
    </Tag>
  )
}

export function StatusChip({ label, severity = 'ok' }: { label: string; severity?: Severity }) {
  const bg: Record<Severity, string> = {
    ok: 'bg-emerald-300/15 text-emerald-200',
    warn: 'bg-amber-300/15 text-amber-200',
    critical: 'bg-rose-300/15 text-rose-200',
  }
  return <span className={`rounded-full px-1.5 py-0 text-[9px] font-bold ${bg[severity]}`}>{label}</span>
}

export function Meter({ label, pct, detail }: { label: string; pct: number; detail?: string }) {
  const sev: Severity = pct >= 90 ? 'critical' : pct >= 75 ? 'warn' : 'ok'
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-[15px] md:text-xs">
        <span className="text-slate-400">{label}</span>
        <span className={`font-bold ${SEV_TEXT[sev]}`}>{Math.round(pct)}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/5">
        <div className={`h-full rounded-full ${SEV_BAR[sev]}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </div>
      {detail && <span className="text-[13px] md:text-[10px] text-[var(--muted)]">{detail}</span>}
    </div>
  )
}

export function StatusDot({ on, labelOn, labelOff }: { on: boolean; labelOn: string; labelOff: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[15px] md:text-xs">
      <span className={`h-2 w-2 rounded-full ${on ? 'bg-emerald-300' : 'bg-rose-300 pulse-dot'}`} />
      <span className={on ? 'text-slate-200' : 'text-rose-200'}>{on ? labelOn : labelOff}</span>
    </span>
  )
}

/**
 * Read-only safe action: copy text to the clipboard with transient feedback.
 * Degrades to a legacy textarea+execCommand path when the async Clipboard API
 * is unavailable (http over Tailscale isn't a secure context).
 */
export function CopyButton({ text, title = 'Copy', label }: { text: string; title?: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle')

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    let ok = false
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        ok = true
      } else {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        ok = document.execCommand('copy')
        document.body.removeChild(ta)
      }
    } catch {
      ok = false
    }
    setState(ok ? 'ok' : 'fail')
    setTimeout(() => setState('idle'), 1500)
  }

  return (
    <button
      onClick={copy}
      title={title}
      className="flex shrink-0 items-center gap-0.5 rounded border border-slate-400/20 bg-black/30 px-1.5 py-0.5 text-[9px] text-slate-400 hover:border-cyan-300/40 hover:text-cyan-100"
    >
      {state === 'ok' ? <Check size={12} className="text-emerald-300" /> : <Copy size={12} />}
      {label && <span>{state === 'ok' ? 'copied' : state === 'fail' ? 'failed' : label}</span>}
    </button>
  )
}

export function CardLoading({ label = 'loading…' }: { label?: string }) {
  // Skeleton shimmer instead of a bare "loading…" line — reads as the surface
  // assembling, not as a hang (design-guidelines §7; fixes the mobile inbox
  // looking broken mid-load).
  return (
    <div className="flex flex-1 flex-col gap-2.5 p-1" role="status" aria-busy="true" aria-label={label}>
      <div className="mc-skeleton h-3 w-1/3" />
      <div className="mc-skeleton h-2.5 w-4/5" />
      <div className="mc-skeleton h-2.5 w-2/3" />
      <div className="mc-skeleton h-20 w-full" />
      <div className="mc-skeleton h-2.5 w-1/2" />
      <div className="mc-skeleton h-2.5 w-3/4" />
    </div>
  )
}

export function CardError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <div className="text-[17px] md:text-sm font-bold text-rose-200">Data unavailable</div>
      <div className="max-w-md text-[15px] md:text-xs text-[var(--muted)]">{message}</div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-1 flex h-9 items-center gap-1.5 rounded-lg border border-cyan-300/40 bg-cyan-300/10 px-3 text-[13px] font-bold text-cyan-100 hover:bg-cyan-300/20"
        >
          <RefreshCw size={14} /> Try again
        </button>
      )}
    </div>
  )
}
