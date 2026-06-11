'use client'

import { Gauge, Sparkles, Terminal, Server } from 'lucide-react'
import { ageLabel, untilLabel } from '@/lib/metis-api'
import { useMetisAll } from '@/lib/use-metis-all'
import { StatusCard, Meter, CardLoading, CardError } from '../overview/cards'
import { AnnotateTrigger } from '../annotate/AnnotateWidget'

/**
 * Usage / AI Capacity mode (PLAN M5/§11.8). Native view of provider capacity
 * from the typed /api/all ratelimits: Claude 5h/7d windows with reset times and
 * spend, Codex token budget, and local Ollama model availability — so "what can
 * I run now, what's waiting for reset" is answerable at a glance.
 */
export default function UsageMode() {
  const { res, data, now, reload } = useMetisAll()
  const rl = data?.ratelimits
  const codexTarget = rl?.codex?.soft_token_target ?? rl?.codex?.daily_token_target
  const codexPct = rl?.codex?.target_pct ?? rl?.codex?.token_pct

  return (
    <div data-testid="usage-mode" className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-[var(--line)] bg-black/20 px-3 py-2 text-[15px] md:text-xs">
        <Gauge size={14} className="text-cyan-300" />
        <span className="text-[17px] md:text-sm font-black uppercase tracking-[0.18em] text-cyan-100">AI Capacity</span>
        <div className="flex-1" />
        {res && <span className="text-[13px] md:text-[10px] text-[var(--muted)]">{res.ok ? `data ${ageLabel(data?.ts, now)}` : 'no data'}</span>}
        <AnnotateTrigger />
      </div>

      {res && !res.ok ? (
        <CardError message={`${res.error} — start the backend on Jay with: bash scripts/restart-dashboard.sh`} onRetry={reload} />
      ) : !data ? (
        <CardLoading label="loading capacity…" />
      ) : (
        <div className="grid flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 md:gap-3 md:p-3 sm:grid-cols-2 xl:grid-cols-3">
          {/* Claude */}
          <StatusCard title="Claude" icon={<Sparkles size={12} />}>
            {rl?.claude?.five_hour ? (
              <Meter label="5-hour window" pct={rl.claude.five_hour.pct} detail={`resets ${untilLabel(rl.claude.five_hour.resets_at, now)}`} />
            ) : null}
            {rl?.claude?.seven_day ? (
              <Meter label="7-day window" pct={rl.claude.seven_day.pct} detail={`resets ${untilLabel(rl.claude.seven_day.resets_at, now)}`} />
            ) : null}
            <div className="mt-1 flex justify-between text-sm md:text-[11px] text-[var(--muted)]">
              <span>spend today</span>
              <span className="text-slate-300">${(rl?.claude?.total_cost ?? 0).toFixed(2)}{rl?.claude?.daily_budget ? ` / $${rl.claude.daily_budget.toFixed(0)}` : ''}</span>
            </div>
            {!rl?.claude && <span className="text-[15px] md:text-xs text-[var(--muted)]">no Claude usage data</span>}
          </StatusCard>

          {/* Codex */}
          <StatusCard title="Codex" icon={<Terminal size={12} />}>
            {typeof codexPct === 'number' ? (
              <Meter label="soft daily target" pct={codexPct} detail={rl?.codex?.limit_known ? 'provider limit' : 'local target, not a hard cap'} />
            ) : null}
            <div className="flex flex-col gap-0.5 text-sm md:text-[11px] text-[var(--muted)]">
              <span>sessions today: <span className="text-slate-300">{rl?.codex?.sessions_today ?? 0}</span></span>
              <span>tokens today: <span className="text-slate-300">{(rl?.codex?.tokens_today ?? 0).toLocaleString()}{codexTarget ? ` / ${codexTarget.toLocaleString()} target` : ''}</span></span>
              {rl?.codex?.source && <span>source: <span className="text-slate-300">{rl.codex.source}</span></span>}
            </div>
            {!rl?.codex?.limit_known && rl?.codex?.limit_note && (
              <div className="mt-2 rounded border border-amber-300/20 bg-amber-300/10 px-2 py-1.5 text-[13px] md:text-[10px] leading-relaxed text-amber-100/80">
                {rl.codex.limit_note}
              </div>
            )}
            {!rl?.codex && <span className="text-[15px] md:text-xs text-[var(--muted)]">no Codex usage data</span>}
          </StatusCard>

          {/* Local models */}
          <StatusCard title="Local · Ollama" icon={<Server size={12} />} severity={data.ollama.running ? 'ok' : 'warn'}>
            <span className="inline-flex items-center gap-1.5 text-[15px] md:text-xs">
              <span className={`h-2 w-2 rounded-full ${data.ollama.running ? 'bg-emerald-300' : 'bg-amber-300'}`} />
              <span className="text-slate-200">{data.ollama.running ? 'available · free capacity' : 'offline'}</span>
            </span>
            <ul className="flex flex-col gap-0.5 text-sm md:text-[11px] text-[var(--muted)]">
              {(data.ollama.models ?? []).slice(0, 5).map((m) => (
                <li key={m.name} className="truncate"><span className="text-slate-300">{m.name}</span> · {m.size_gb.toFixed(1)}GB</li>
              ))}
            </ul>
          </StatusCard>
        </div>
      )}
    </div>
  )
}
