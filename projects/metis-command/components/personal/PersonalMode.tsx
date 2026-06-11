'use client'

import { HeartPulse, Wallet, PiggyBank, TrendingUp, Dumbbell, Moon, Footprints, GitCommitHorizontal, CalendarDays, ListChecks } from 'lucide-react'
import { ageLabel } from '@/lib/metis-api'
import { useMetisAll } from '@/lib/use-metis-all'
import { StatusCard, Meter, CardLoading, CardError } from '../overview/cards'
import { AnnotateTrigger } from '../annotate/AnnotateWidget'

/**
 * Personal mode (PLAN §7.6 — retire the legacy dashboard's life-management panels
 * into the Control Center). Native view of finance / budget / portfolio / health / workouts
 * from the typed /api/all. Read-only. Values are rendered straight from the local
 * data plane — no money is hardcoded in this file (public-launch safe; the numbers
 * live only in the local personal.db the API reads).
 */

// Loose shapes for the /api/all personal keys (intentionally untyped in
// metis-api-types until a card needs them — keeps the strict contract operational).
interface Finance { net_worth?: number; assets?: number; liabilities?: number; updated_at?: string; error?: string | null }
interface Budget { month?: string; income?: number; expense?: number; net_cashflow?: number; savings_rate?: number; daily_burn?: number; budget_remaining?: number; days_in_month?: number; day_elapsed?: number }
interface Portfolio { total_value?: number; concentration?: { top_holding_pct?: number; top5_pct?: number; flagged?: unknown[] }; positions?: unknown[] }
interface Garmin { daily?: { steps?: number; active_minutes?: number; calories_active?: number; body_battery_high?: number; stress_avg?: number; floors?: number }; sleep?: { sleep_score?: number }; last_sync?: string; last_error?: string | null }
interface Fitbod { totals?: { workouts?: number; sets?: number; exercises?: number }; last_error?: string | null }
interface GithubRepo { repo: string; commits?: { sha?: string; message?: string; author?: string; date?: string }[] }
interface PersonalFeeds {
  reminders?: { items?: { list?: string; title?: string }[]; count?: number; age_min?: number }
  calendar?: { events?: { start_fmt?: string; summary?: string }[] }
  notion?: { items?: { title?: string; status?: string; due?: string; url?: string }[] }
}
interface PlaidWindow extends Window { Plaid?: { create: (config: { token: string; onSuccess: (publicToken: string, metadata: unknown) => void | Promise<void> }) => { open: () => void } } }
interface PlaidStatus { configured?: boolean; next?: string }
interface PlaidToken { link_token?: string; error?: string }
interface PlaidResult { error?: string }
interface PlaidReconcile { rows?: { status?: string }[]; unmatched_tiller?: unknown[] }

const usd = (n?: number) => (typeof n === 'number' ? '$' + Math.round(n).toLocaleString() : '—')
const asPct = (n?: number) => (typeof n === 'number' ? `${Math.round(n <= 1 ? n * 100 : n)}%` : '—')
const num = (n?: number) => (typeof n === 'number' ? n.toLocaleString() : '—')

let plaidScriptPromise: Promise<void> | null = null

function loadPlaidScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  const plaidWindow = window as PlaidWindow
  if (plaidWindow.Plaid) return Promise.resolve()
  if (plaidScriptPromise) return plaidScriptPromise
  plaidScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Plaid Link script failed to load'))
    document.head.appendChild(script)
  })
  return plaidScriptPromise
}

export default function PersonalMode() {
  const { res, data, now, reload, hardReload } = useMetisAll()

  const fin = data?.finance as Finance | undefined
  const bud = data?.budget as Budget | undefined
  const pf = data?.portfolio as Portfolio | undefined
  const gar = data?.garmin as Garmin | undefined
  const fb = data?.fitbod as Fitbod | undefined
  const gh = data?.github as GithubRepo[] | undefined
  const feeds = data?.personal as PersonalFeeds | undefined

  const flagged = pf?.concentration?.flagged?.length ?? 0
  const monthProgress = bud?.days_in_month ? Math.round(((bud.day_elapsed ?? 0) / bud.days_in_month) * 100) : 0

  async function linkPlaid() {
    try {
      const st: PlaidStatus = await fetch('/api/metis/plaid/status').then((r) => r.json())
      if (!st.configured) {
        window.alert(`Plaid is not configured yet:\n\n${st.next ?? 'Set PLAID_CLIENT_ID and PLAID_SECRET.'}`)
        return
      }
      await loadPlaidScript()
      const tok: PlaidToken = await fetch('/api/metis/plaid/link-token', { method: 'POST' }).then((r) => r.json())
      if (tok.error || !tok.link_token) {
        window.alert(`Plaid link token failed: ${tok.error ?? 'missing link_token'}`)
        return
      }
      const plaid = (window as PlaidWindow).Plaid
      if (!plaid) {
        window.alert('Plaid Link did not load.')
        return
      }
      const handler = plaid.create({
        token: tok.link_token,
        onSuccess: async (public_token: string, metadata: unknown) => {
          const ex: PlaidResult = await fetch('/api/metis/plaid/exchange', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ public_token, metadata }),
          }).then((r) => r.json())
          if (ex.error) {
            window.alert(`Plaid token exchange failed: ${ex.error}`)
            return
          }
          const sync: PlaidResult = await fetch('/api/metis/plaid/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transactions: true }),
          }).then((r) => r.json())
          if (sync.error) {
            window.alert(`Plaid sync failed: ${sync.error}`)
            return
          }
          hardReload()
        },
      })
      handler.open()
    } catch (error) {
      window.alert(`Plaid error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function reviewSources() {
    try {
      const rec: PlaidReconcile = await fetch('/api/metis/plaid/reconcile').then((r) => r.json())
      const mismatches = (rec.rows ?? []).filter((row) => row.status === 'mismatch').length
      const unmatched = (rec.rows ?? []).filter((row) => row.status === 'unmatched').length
      window.alert(`Plaid/Tiller reconciliation\n\nPlaid accounts: ${rec.rows?.length ?? 0}\nMismatches: ${mismatches}\nUnmatched Plaid: ${unmatched}\nUnmatched Tiller: ${rec.unmatched_tiller?.length ?? 0}`)
    } catch (error) {
      window.alert(`Source review failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return (
    <div data-testid="personal-mode" className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-[var(--line)] bg-black/20 px-3 py-2 text-[15px] md:text-[12px]">
        <HeartPulse size={14} className="text-cyan-300" />
        <span className="text-[17px] md:text-[13px] font-black uppercase tracking-[0.18em] text-cyan-100">Personal</span>
        <div className="flex-1" />
        {res && <span className="text-[13px] md:text-[10px] text-[var(--muted)]">{res.ok ? `data ${ageLabel(data?.ts, now)}` : 'no data'}</span>}
        <AnnotateTrigger />
      </div>

      {res && !res.ok ? (
        <CardError message={`${res.error} — start the backend on Jay with: bash scripts/restart-dashboard.sh`} onRetry={reload} />
      ) : !data ? (
        <CardLoading label="loading personal…" />
      ) : (
        <div className="mc-stagger grid flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 md:gap-3 md:p-3 sm:grid-cols-2 xl:grid-cols-3">
          {/* Net Worth */}
          <StatusCard title="Net Worth" icon={<Wallet size={12} />} severity={fin?.error ? 'warn' : 'ok'}>
            {fin?.error ? (
              <span className="text-[13px] md:text-[11px] text-amber-200">finance sync error</span>
            ) : (
              <div className="flex flex-col gap-0.5 text-[13px] md:text-[11px] text-[var(--muted)]">
                <span className="text-[17px] font-black text-slate-100">{usd(fin?.net_worth)}</span>
                <span>assets <span className="text-emerald-200">{usd(fin?.assets)}</span></span>
                <span>liabilities <span className="text-rose-200">{usd(fin?.liabilities)}</span></span>
                {fin?.updated_at && <span className="text-[13px] md:text-[10px]">updated {ageLabel(fin.updated_at, now)}</span>}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <button onClick={linkPlaid} className="rounded-md border border-cyan-300/25 bg-cyan-300/10 px-2 py-1 text-[13px] md:text-[10px] font-semibold text-cyan-100 hover:border-cyan-200/60">
                    Link Plaid
                  </button>
                  <button onClick={reviewSources} className="rounded-md border border-slate-400/20 bg-black/30 px-2 py-1 text-[13px] md:text-[10px] font-semibold text-slate-200 hover:border-cyan-300/40 hover:text-cyan-100">
                    Review sources
                  </button>
                </div>
              </div>
            )}
          </StatusCard>

          {/* Budget */}
          <StatusCard title={`Budget · ${bud?.month ?? '—'}`} icon={<PiggyBank size={12} />}>
            <Meter label="Month elapsed" pct={monthProgress} />
            <div className="mt-1 flex flex-col gap-0.5 text-[13px] md:text-[11px] text-[var(--muted)]">
              <span>income <span className="text-emerald-200">{usd(bud?.income)}</span> · spent <span className="text-rose-200">{usd(bud?.expense)}</span></span>
              <span>savings rate <span className="text-slate-200">{asPct(bud?.savings_rate)}</span> · burn/day <span className="text-slate-200">{usd(bud?.daily_burn)}</span></span>
              <span>remaining <span className="text-cyan-200">{usd(bud?.budget_remaining)}</span></span>
            </div>
          </StatusCard>

          {/* Portfolio */}
          <StatusCard title="Portfolio" icon={<TrendingUp size={12} />} severity={flagged ? 'warn' : 'ok'}>
            <span className="text-[17px] font-black text-slate-100">{usd(pf?.total_value)}</span>
            {typeof pf?.concentration?.top_holding_pct === 'number' && <Meter label="Top holding" pct={Math.round(pf.concentration.top_holding_pct)} />}
            <div className="flex flex-col gap-0.5 text-[13px] md:text-[11px] text-[var(--muted)]">
              <span>positions <span className="text-slate-200">{pf?.positions?.length ?? 0}</span> · top-5 <span className="text-slate-200">{asPct(pf?.concentration?.top5_pct)}</span></span>
              <span>cap breaches <span className={flagged ? 'text-amber-200' : 'text-emerald-200'}>{flagged}</span></span>
            </div>
          </StatusCard>

          {/* Health (Garmin) */}
          <StatusCard title="Health · Garmin" icon={<HeartPulse size={12} />} severity={gar?.last_error ? 'warn' : 'ok'}>
            <div className="flex flex-col gap-0.5 text-[13px] md:text-[11px] text-[var(--muted)]">
              <span className="flex items-center gap-1"><Footprints size={12} /> {num(gar?.daily?.steps)} steps · {num(gar?.daily?.active_minutes)} active min</span>
              <span className="flex items-center gap-1"><Moon size={12} /> sleep score {gar?.sleep?.sleep_score ?? '—'} · stress {gar?.daily?.stress_avg ?? '—'}</span>
              <span>body battery {gar?.daily?.body_battery_high ?? '—'} · floors {gar?.daily?.floors ?? '—'}</span>
              {gar?.last_sync && <span className="text-[13px] md:text-[10px]">synced {ageLabel(gar.last_sync, now)}</span>}
            </div>
          </StatusCard>

          {/* Workouts (Fitbod) */}
          <StatusCard title="Workouts · Fitbod" icon={<Dumbbell size={12} />} severity={fb?.last_error ? 'warn' : 'ok'}>
            {fb?.last_error && !fb?.totals?.workouts ? (
              <span className="text-[13px] md:text-[11px] text-amber-200">no workout data ingested yet</span>
            ) : (
              <div className="flex flex-col gap-0.5 text-[13px] md:text-[11px] text-[var(--muted)]">
                <span>workouts <span className="text-slate-200">{num(fb?.totals?.workouts)}</span> · sets <span className="text-slate-200">{num(fb?.totals?.sets)}</span></span>
                <span>exercises <span className="text-slate-200">{num(fb?.totals?.exercises)}</span></span>
              </div>
            )}
          </StatusCard>

          {/* GitHub repos (latest commit per tracked repo) */}
          <StatusCard title="GitHub · Repos" icon={<GitCommitHorizontal size={12} />}>
            {gh?.length ? (
              <div className="flex flex-col gap-1 text-[13px] md:text-[11px] text-[var(--muted)]">
                {gh.slice(0, 4).map((r) => (
                  <div key={r.repo} className="flex flex-col">
                    <span className="font-bold text-slate-200">{r.repo}</span>
                    {r.commits?.[0] && (
                      <span className="truncate text-[13px] md:text-[10px]">
                        <span className="text-cyan-200">{r.commits[0].sha}</span> {r.commits[0].message} · {r.commits[0].author}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <span className="text-[13px] md:text-[11px] text-[var(--muted)]">no repo data</span>
            )}
          </StatusCard>

          {/* Calendar (upcoming events) */}
          <StatusCard title="Calendar" icon={<CalendarDays size={12} />}>
            {feeds?.calendar?.events?.length ? (
              <div className="flex flex-col gap-0.5 text-[13px] md:text-[11px] text-[var(--muted)]">
                {feeds.calendar.events.slice(0, 5).map((e, i) => (
                  <span key={i} className="truncate">
                    <span className="text-cyan-200">{e.start_fmt}</span> <span className="text-slate-300">{e.summary}</span>
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-[13px] md:text-[11px] text-[var(--muted)]">no upcoming events</span>
            )}
          </StatusCard>

          {/* To-Dos (Apple Reminders + Notion) */}
          <StatusCard title="To-Dos" icon={<ListChecks size={12} />}>
            <div className="flex flex-col gap-0.5 text-[13px] md:text-[11px] text-[var(--muted)]">
              <span>reminders <span className="text-slate-200">{feeds?.reminders?.count ?? feeds?.reminders?.items?.length ?? 0}</span> · notion <span className="text-slate-200">{feeds?.notion?.items?.length ?? 0}</span></span>
              {(feeds?.reminders?.items ?? []).slice(0, 3).map((r, i) => (
                <span key={`r${i}`} className="truncate">• {r.title}</span>
              ))}
              {(feeds?.notion?.items ?? []).slice(0, 2).map((t, i) => (
                <span key={`n${i}`} className="truncate">
                  ◆ {t.title} {t.status ? <span className="text-[13px] md:text-[10px] text-amber-200/80">[{t.status}]</span> : null}
                </span>
              ))}
            </div>
          </StatusCard>
        </div>
      )}
    </div>
  )
}
