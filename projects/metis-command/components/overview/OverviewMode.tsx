'use client'

import { useState } from 'react'
import OverviewSummary from './OverviewSummary'
import SystemMapPanel from './SystemMapPanel'
import { AnnotateTrigger } from '../annotate/AnnotateWidget'

type SubView = 'status' | 'map'

/**
 * Overview mode — the native React status surface. The transitional "Dashboard
 * Legacy" iframe and its Native/Legacy strangler toggle were retired once the
 * native Overview reached parity for daily-use cards (PLAN §7.6 deletion
 * ledger). The FastAPI backend remains the data plane behind /api/all; only the
 * legacy *frontend* embed is gone. A thin header keeps the desktop Annotate
 * entry point; the `overview-mode` testid stays stable for e2e.
 *
 * Sub-views: Status (cards) · Map (SystemMapPanel — interactive system topology + progress).
 */
export default function OverviewMode() {
  const [sub, setSub] = useState<SubView>('status')

  return (
    <div data-testid="overview-mode" className="flex h-full w-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--line)] bg-black/30 px-2 py-1.5">
        <div data-testid="subview-toggle" className="flex gap-1">
          {(['status', 'map'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setSub(v)}
              className={[
                'rounded px-2 py-0.5 text-[10px] uppercase tracking-widest font-semibold transition-colors',
                sub === v
                  ? 'bg-cyan-900/40 text-cyan-300 border border-cyan-700/50'
                  : 'text-[var(--muted)] border border-transparent hover:text-cyan-400',
              ].join(' ')}
            >
              {v === 'status' ? 'Status' : 'Map'}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <AnnotateTrigger />
      </div>
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        {sub === 'status' ? (
          <OverviewSummary />
        ) : (
          <SystemMapPanel />
        )}
      </div>
    </div>
  )
}
