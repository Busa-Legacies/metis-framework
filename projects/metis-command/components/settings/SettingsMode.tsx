'use client'

import { Settings, Plug, Network, ShieldCheck, HeartPulse, Briefcase } from 'lucide-react'
import { ageLabel } from '@/lib/metis-api'
import { useMetisAll } from '@/lib/use-metis-all'
import { integrationStatuses } from '@/lib/integration-health'
import { StatusCard, StatusDot, CardLoading, CardError, SEV_DOT, SEV_TEXT } from '../overview/cards'
import { AnnotateTrigger } from '../annotate/AnnotateWidget'
import { useWorkspace } from '@/lib/workspace-context'
import { WORKSPACES, type Workspace } from '@/lib/workspace'
import { useAuthStatus } from '@/lib/use-auth-status'

const ACTION_TIERS = [
  { tier: 'Read', examples: 'inspect status, view tasks, open logs', gate: 'none' },
  { tier: 'Local reversible', examples: 'refresh, open pane, copy handoff prompt', gate: 'direct' },
  { tier: 'Shared state', examples: 'claim/finish task, restart service', gate: 'governed + audit' },
  { tier: 'External / irreversible', examples: 'publish, live trade, delete', gate: 'confirm / Ant-present' },
]

/**
 * Settings mode (PLAN §9.1, read-only first slice). Integration/auth health
 * (§8.5 — show the exact missing capability), machine routing, and a visible
 * record of the §8.6 action-gate tiers so the safety model is inspectable.
 * Mutating config lands behind the gated-actions work.
 */
export default function SettingsMode() {
  const { res, data, now, reload } = useMetisAll()

  return (
    <div data-testid="settings-mode" className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-[var(--line)] bg-black/20 px-3 py-2 text-[15px] md:text-[12px]">
        <Settings size={14} className="text-cyan-300" />
        <span className="text-[17px] md:text-[13px] font-black uppercase tracking-[0.18em] text-cyan-100">Settings</span>
        <div className="flex-1" />
        {res && <span className="text-[13px] md:text-[10px] text-[var(--muted)]">{res.ok ? `data ${ageLabel(data?.ts, now)}` : 'no data'}</span>}
        <AnnotateTrigger />
      </div>

      {/* Workspace switch — re-scopes the whole Control Center between Personal and the
          Navore professional context. Always available (independent of /api/all)
          so you can switch even when the backend is down. */}
      <div className="shrink-0 border-b border-[var(--line)] bg-black/10 px-4 py-3">
        <WorkspaceToggle />
        <NavoreAccountStatus />
      </div>

      {res && !res.ok ? (
        <CardError message={`${res.error} — start the backend on Jay with: bash scripts/restart-dashboard.sh`} onRetry={reload} />
      ) : !data ? (
        <CardLoading label="loading settings…" />
      ) : (
        <div className="grid flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 md:gap-3 md:p-3 sm:grid-cols-2 xl:grid-cols-3">
          {/* Integrations */}
          <StatusCard title="Integrations · Auth" icon={<Plug size={12} />}>
            <ul className="flex flex-col gap-1.5">
              {integrationStatuses(data).map((s) => (
                <li key={s.name} className="flex flex-col gap-0.5 text-[13px] md:text-[11px]">
                  <div className="flex items-start gap-1.5">
                    <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${SEV_DOT[s.severity]}`} />
                    <span className="shrink-0 text-slate-200">{s.name}</span>
                    <span className={`ml-auto truncate text-[13px] md:text-[10px] ${s.severity === 'ok' ? 'text-[var(--muted)]' : SEV_TEXT[s.severity]}`}>{s.detail}</span>
                  </div>
                  {s.fix && (
                    <a
                      href={s.fix.href}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-3 inline-flex w-fit items-center gap-1 rounded-md border border-amber-300/30 bg-amber-300/5 px-1.5 py-0.5 text-[12px] md:text-[10px] text-amber-200 hover:bg-amber-300/10"
                    >
                      {s.fix.label} <span aria-hidden>↗</span>
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </StatusCard>

          {/* Machines & routing */}
          <StatusCard title="Machines · Routing" icon={<Network size={12} />}>
            <StatusDot on={data.jay.gateway_running} labelOn="Jay gateway up" labelOff="Jay gateway down" />
            <StatusDot on={data.ollama.running} labelOn={`Ollama up · ${data.ollama.models?.length ?? 0} models`} labelOff="Ollama down" />
            <span className="text-[13px] md:text-[11px] text-[var(--muted)]">tailscale: <span className="text-slate-300">{data.remote.tailscale_ip || '—'}</span></span>
            <span className="text-[13px] md:text-[11px] text-[var(--muted)]">model: <span className="text-slate-300">{data.jay.primary_model || '—'}</span></span>
          </StatusCard>

          {/* Action gates (safety model, §8.6) */}
          <StatusCard title="Action Gates" icon={<ShieldCheck size={12} />}>
            <ul className="flex flex-col gap-1.5">
              {ACTION_TIERS.map((t) => (
                <li key={t.tier} className="flex flex-col text-[13px] md:text-[11px]">
                  <div className="flex items-center gap-1.5">
                    <span className="text-slate-200">{t.tier}</span>
                    <span className="ml-auto rounded-full bg-cyan-300/10 px-1.5 py-0 text-[9px] font-bold text-cyan-200">{t.gate}</span>
                  </div>
                  <span className="text-[13px] md:text-[10px] text-[var(--muted)]">{t.examples}</span>
                </li>
              ))}
            </ul>
          </StatusCard>
        </div>
      )}
    </div>
  )
}

const WORKSPACE_ICON: Record<Workspace, React.ReactNode> = {
  personal: <HeartPulse size={14} />,
  professional: <Briefcase size={14} />,
}

/** Navore Claude account link status — professional-workspace agents run under
 *  it once linked. Loading is a Jay-side `claude setup-token` step; this just
 *  reflects whether the Control Center can see the credential. */
function NavoreAccountStatus() {
  const status = useAuthStatus()
  const linked = status?.claudeNavore?.linked === true
  return (
    <div className="mt-3 flex items-start gap-1.5 text-[12px] md:text-[11px]">
      <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${linked ? 'bg-emerald-300' : 'bg-amber-300'}`} />
      <div className="flex flex-col">
        <span className="text-slate-200">
          Navore Claude account · <span className={linked ? 'text-emerald-200' : 'text-amber-200'}>{linked ? 'linked' : 'not linked'}</span>
        </span>
        {!linked && (
          <span className="text-[var(--muted)]">
            Run <code className="text-slate-300">claude setup-token</code> for the Navore login on Jay and set{' '}
            <code className="text-slate-300">AW_CLAUDE_NAVORE_OAUTH_TOKEN</code> in the workbench env. See{' '}
            <span className="text-slate-300">docs/process/navore-claude-account.md</span>.
          </span>
        )}
      </div>
    </div>
  )
}

/** Personal ↔ Professional(Navore) switch — the canonical workspace control. */
function WorkspaceToggle() {
  const { workspace, setWorkspace } = useWorkspace()
  return (
    <div className="flex flex-col gap-2" data-testid="workspace-toggle">
      <div className="flex items-center gap-1.5 text-[13px] md:text-[10px] font-black uppercase tracking-[0.18em] text-cyan-200">
        <Briefcase size={12} />
        <span>Workspace</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:max-w-md">
        {(Object.keys(WORKSPACES) as Workspace[]).map((id) => {
          const w = WORKSPACES[id]
          const active = workspace === id
          const accent = w.accent === 'amber'
          return (
            <button
              key={id}
              onClick={() => setWorkspace(id)}
              aria-pressed={active}
              data-testid={`workspace-option-${id}`}
              className={`flex flex-col gap-0.5 rounded-xl border px-3 py-2 text-left transition-colors ${
                active
                  ? accent
                    ? 'border-amber-300/50 bg-amber-300/10'
                    : 'border-cyan-300/50 bg-cyan-300/10'
                  : 'border-[var(--line)] bg-black/20 hover:border-slate-400/40'
              }`}
            >
              <span className={`flex items-center gap-1.5 text-[13px] md:text-[12px] font-bold ${active ? (accent ? 'text-amber-100' : 'text-cyan-100') : 'text-slate-300'}`}>
                {WORKSPACE_ICON[id]} {w.label}
                {active && <span className="ml-auto text-[10px] uppercase tracking-[0.1em] opacity-70">active</span>}
              </span>
              <span className="text-[12px] md:text-[10px] text-[var(--muted)]">{w.blurb}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
