'use client'

import { AlertTriangle, Cpu, Server, CandlestickChart, Gauge, ListTodo } from 'lucide-react'
import { topAlertSeverity, ageLabel } from '@/lib/metis-api'
import { useMetisAll } from '@/lib/use-metis-all'
import { useControlCenterNav } from '@/lib/control-center-nav'
import { StatusCard, Meter, StatusDot, CardLoading, CardError, SEV_TEXT, SEV_BAR, levelToSeverity } from './cards'
import AgentActivityCard from './AgentActivityCard'

/**
 * Native React Overview — the high-signal status surface ported off the legacy
 * dashboard iframe (PLAN M2/M3). Reads the typed /api/all via the metis-api
 * client, renders shared design-system cards with explicit degraded/stale
 * states and visible data age, and routes from each card into its action mode
 * (observe→act, §8).
 */
export default function OverviewSummary() {
  const nav = useControlCenterNav()
  const { res, data, now, reload: load } = useMetisAll()
  const codexPct = data?.ratelimits?.codex?.target_pct ?? data?.ratelimits?.codex?.token_pct
  const system = {
    cpu_pct: data?.system?.cpu_pct ?? 0,
    ram_pct: data?.system?.ram_pct ?? 0,
    ram_used_gb: data?.system?.ram_used_gb ?? 0,
    ram_total_gb: data?.system?.ram_total_gb ?? 0,
    disk_pct: data?.system?.disk_pct ?? 0,
    disk_used_gb: data?.system?.disk_used_gb ?? 0,
    disk_total_gb: data?.system?.disk_total_gb ?? 0,
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* header / freshness rail */}
      <div className="flex items-center gap-2 border-b border-[var(--line)] bg-black/20 px-3 py-2 text-[15px] md:text-[12px]">
        <span className="text-[17px] md:text-[13px] font-black uppercase tracking-[0.18em] text-cyan-100">Overview</span>
        <span className="badge">native</span>
        <div className="flex-1" />
        {res && (
          <span className="text-[13px] md:text-[10px] text-[var(--muted)]">
            {res.ok ? `data ${ageLabel(data?.ts, now)} · fetched ${ageLabel(res.fetchedAt, now)}` : 'no data'}
          </span>
        )}
      </div>

      {res && !res.ok ? (
        <CardError
          message={`${res.error} — start the backend on Jay with: bash scripts/restart-dashboard.sh`}
          onRetry={load}
        />
      ) : !data ? (
        <CardLoading label="loading overview…" />
      ) : (
        <div className="mc-stagger grid flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 md:gap-3 md:p-3 sm:grid-cols-2 xl:grid-cols-3">
          {/* Live agent activity (#240 Phase 4) — cross-workspace heartbeat */}
          <AgentActivityCard />

          {/* Alerts */}
          <StatusCard title="Alerts" icon={<AlertTriangle size={12} className={SEV_TEXT[topAlertSeverity(data.alerts)]} />} severity={topAlertSeverity(data.alerts)}>
            {data.alerts?.length ? (
              <ul className="flex flex-col gap-1">
                {data.alerts.slice(0, 5).map((a, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-[15px] md:text-[12px]">
                    <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${SEV_BAR[levelToSeverity(a.level)]}`} />
                    <span className="text-slate-300">{a.msg}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-[15px] md:text-[12px] text-emerald-200">All clear</span>
            )}
          </StatusCard>

          {/* System → Ops */}
          <StatusCard title="System" icon={<Cpu size={12} />} onClick={() => nav.goto('ops')} actionHint="Open Ops">
            <Meter label="CPU" pct={system.cpu_pct} />
            <Meter label="RAM" pct={system.ram_pct} detail={`${system.ram_used_gb.toFixed(1)} / ${system.ram_total_gb.toFixed(0)} GB`} />
            <Meter label="Disk" pct={system.disk_pct} detail={`${system.disk_used_gb.toFixed(0)} / ${system.disk_total_gb.toFixed(0)} GB`} />
          </StatusCard>

          {/* Jay / Ollama → Ops */}
          <StatusCard title="Jay · Models" icon={<Server size={12} />} severity={data.jay.gateway_running && data.ollama.running ? 'ok' : 'critical'} onClick={() => nav.goto('ops')} actionHint="Open Ops">
            <StatusDot on={data.jay.gateway_running} labelOn="gateway up" labelOff="gateway down" />
            <span className="text-[13px] md:text-[11px] text-[var(--muted)]">model: <span className="text-slate-300">{data.jay.primary_model || '—'}</span></span>
            <StatusDot on={data.ollama.running} labelOn={`ollama up · ${data.ollama.models?.length ?? 0} models`} labelOff="ollama down" />
          </StatusCard>

          {/* Trading bot → Ops */}
          <StatusCard title="Trading Bot" icon={<CandlestickChart size={12} />} severity={data.bot.running ? 'ok' : 'warn'} onClick={() => nav.goto('ops')} actionHint="Open Ops">
            <StatusDot on={data.bot.running} labelOn={`running · ${data.bot.mode}`} labelOff="stopped" />
            {data.bot.strategy && (
              <span className="text-[13px] md:text-[11px] text-[var(--muted)]">
                {data.bot.strategy.name} ({data.bot.strategy.fast_ma}/{data.bot.strategy.slow_ma})
              </span>
            )}
            <span className="text-[13px] md:text-[10px] text-[var(--muted)]">pid {data.bot.pid || '—'}</span>
          </StatusCard>

          {/* Usage → Usage */}
          <StatusCard title="AI Usage" icon={<Gauge size={12} />} onClick={() => nav.goto('usage')} actionHint="Open Usage">
            {data.ratelimits?.claude?.five_hour ? <Meter label="Claude 5h" pct={data.ratelimits.claude.five_hour.pct} /> : null}
            {data.ratelimits?.claude?.seven_day ? (
              <Meter label="Claude 7d" pct={data.ratelimits.claude.seven_day.pct} detail={`$${(data.ratelimits.claude.total_cost ?? 0).toFixed(2)} spent`} />
            ) : null}
            {typeof codexPct === 'number' ? <Meter label="Codex target" pct={codexPct} detail={data.ratelimits?.codex?.limit_known ? undefined : 'soft target'} /> : null}
            {!data.ratelimits?.claude && !data.ratelimits?.codex && <span className="text-[15px] md:text-[12px] text-[var(--muted)]">no usage data</span>}
          </StatusCard>

          {/* Active work → Work / Map */}
          <StatusCard title="Active Work" icon={<ListTodo size={12} />} severity={data.priorities?.blocked_count ? 'warn' : 'ok'} onClick={() => nav.goto('work-graph')} actionHint="Open Work Map">
            <div className="flex gap-3 text-[15px] md:text-[12px]">
              <span className="text-slate-300">{data.priorities?.active_total ?? 0} active</span>
              <span className={data.priorities?.blocked_count ? 'text-amber-200' : 'text-[var(--muted)]'}>
                {data.priorities?.blocked_count ?? 0} blocked
              </span>
            </div>
            <ul className="flex flex-col gap-0.5">
              {(data.priorities?.next ?? []).slice(0, 4).map((t) => (
                <li key={t.taskId} className="truncate text-[13px] md:text-[11px] text-slate-400">
                  <span className="text-cyan-200">{t.taskId}</span> {t.title}
                </li>
              ))}
            </ul>
          </StatusCard>
        </div>
      )}
    </div>
  )
}
