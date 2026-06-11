'use client'

import { Server, Cpu, Database, Radio, Wifi, Power } from 'lucide-react'
import { ageLabel, metisApi } from '@/lib/metis-api'
import { useMetisAll } from '@/lib/use-metis-all'
import { StatusCard, Meter, StatusDot, CardLoading, CardError } from '../overview/cards'
import { ConfirmActionButton } from '../actions/ConfirmActionButton'
import { AnnotateTrigger } from '../annotate/AnnotateWidget'

/**
 * Ops / Infrastructure mode (PLAN §9.5). Native view of services, machine
 * health, memory RAG, and remote access from the typed /api/all — the place
 * the Overview system/Jay/bot cards route into. Read-only; safe restart/repair
 * actions are a governed follow-up (§8.6).
 */
export default function OpsMode() {
  const { res, data, now, reload } = useMetisAll()
  const system = {
    cpu_pct: data?.system?.cpu_pct ?? 0,
    ram_pct: data?.system?.ram_pct ?? 0,
    ram_used_gb: data?.system?.ram_used_gb ?? 0,
    ram_total_gb: data?.system?.ram_total_gb ?? 0,
    disk_pct: data?.system?.disk_pct ?? 0,
    disk_used_gb: data?.system?.disk_used_gb ?? 0,
    disk_total_gb: data?.system?.disk_total_gb ?? 0,
  }
  const memory = {
    chunks_indexed: data?.memory?.chunks_indexed ?? 0,
    files_indexed: data?.memory?.files_indexed ?? 0,
    reranker_available: data?.memory?.reranker_available ?? false,
    upgrade: data?.memory?.upgrade,
  }

  return (
    <div data-testid="ops-mode" className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-[var(--line)] bg-black/20 px-3 py-2 text-[15px] md:text-xs">
        <Server size={14} className="text-cyan-300" />
        <span className="text-[17px] md:text-sm font-black uppercase tracking-[0.18em] text-cyan-100">Ops</span>
        <div className="flex-1" />
        {res && <span className="text-[13px] md:text-[10px] text-[var(--muted)]">{res.ok ? `data ${ageLabel(data?.ts, now)}` : 'no data'}</span>}
        <AnnotateTrigger />
      </div>

      {res && !res.ok ? (
        <CardError message={`${res.error} — start the backend on Jay with: bash scripts/restart-dashboard.sh`} onRetry={reload} />
      ) : !data ? (
        <CardLoading label="loading ops…" />
      ) : (
        <div className="mc-stagger grid flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 md:gap-3 md:p-3 sm:grid-cols-2 xl:grid-cols-3">
          {/* Services */}
          <StatusCard title="Services" icon={<Radio size={12} />} severity={data.jay.gateway_running && data.ollama.running ? 'ok' : 'critical'}>
            <StatusDot on={data.jay.gateway_running} labelOn="gateway up" labelOff="gateway down" />
            <StatusDot on={data.ollama.running} labelOn={`ollama up · ${data.ollama.models?.length ?? 0} models`} labelOff="ollama down" />
            {/* #240 confirm-gated action — restored after the convergence recovery
                adopted a pre-restart OpsMode and silently dropped this wiring. */}
            <div className="flex items-center justify-between gap-2">
              <StatusDot on={data.bot.running} labelOn={`trading bot · ${data.bot.mode}`} labelOff="trading bot stopped" />
              <ConfirmActionButton
                label={<><Power size={14} /> restart</>}
                title="Restart trading bot"
                body={`This restarts the trading bot process (currently ${data.bot.running ? `running · ${data.bot.mode}` : 'stopped'}). It's the dry-run/paper bot, so this is recoverable — the action only reports success once the process survives startup.`}
                confirmLabel="Restart bot"
                run={async () => {
                  const r = await metisApi.restartBot()
                  return { ok: r.ok, msg: r.ok ? (r.log_tail ?? 'bot restarted') : (r.error ?? 'restart failed') }
                }}
              />
            </div>
          </StatusCard>

          {/* System */}
          <StatusCard title="System · Jay" icon={<Cpu size={12} />}>
            <Meter label="CPU" pct={system.cpu_pct} />
            <Meter label="RAM" pct={system.ram_pct} detail={`${system.ram_used_gb.toFixed(1)} / ${system.ram_total_gb.toFixed(0)} GB`} />
            <Meter label="Disk" pct={system.disk_pct} detail={`${system.disk_used_gb.toFixed(0)} / ${system.disk_total_gb.toFixed(0)} GB`} />
            <span className="text-[13px] md:text-[10px] text-[var(--muted)]">model: <span className="text-slate-300">{data.jay.primary_model || '—'}</span></span>
          </StatusCard>

          {/* Memory RAG */}
          <StatusCard title="Memory RAG" icon={<Database size={12} />}>
            <div className="flex flex-col gap-0.5 text-sm md:text-[11px] text-[var(--muted)]">
              <span>chunks indexed: <span className="text-slate-300">{memory.chunks_indexed.toLocaleString()}</span></span>
              <span>files indexed: <span className="text-slate-300">{memory.files_indexed}</span></span>
              <span>reranker: <span className={memory.reranker_available ? 'text-emerald-200' : 'text-amber-200'}>{memory.reranker_available ? 'available' : 'off'}</span></span>
              {memory.upgrade && <span className="truncate">tier {memory.upgrade.current_tier} · {memory.upgrade.files_until_upgrade} to next</span>}
            </div>
          </StatusCard>

          {/* Remote access */}
          <StatusCard title="Remote Access" icon={<Wifi size={12} />}>
            <span className="text-sm md:text-[11px] text-[var(--muted)]">tailscale: <span className="text-slate-300">{data.remote.tailscale_ip || '—'}</span></span>
            <StatusDot on={data.remote.ssh?.running} labelOn="ssh up" labelOff="ssh down" />
            <StatusDot on={data.remote.ttyd?.running} labelOn="ttyd up" labelOff="ttyd down" />
            {data.remote.tmux_sessions && <span className="truncate text-[13px] md:text-[10px] text-[var(--muted)]">tmux: {data.remote.tmux_sessions}</span>}
          </StatusCard>
        </div>
      )}
    </div>
  )
}
