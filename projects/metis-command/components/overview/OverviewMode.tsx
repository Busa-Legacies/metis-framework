'use client'

import OverviewSummary from './OverviewSummary'
import { AnnotateTrigger } from '../annotate/AnnotateWidget'

/**
 * Overview mode — the native React status surface. The transitional "Dashboard
 * Legacy" iframe and its Native/Legacy strangler toggle were retired once the
 * native Overview reached parity for daily-use cards (PLAN §7.6 deletion
 * ledger). The FastAPI backend remains the data plane behind /api/all; only the
 * legacy *frontend* embed is gone. A thin header keeps the desktop Annotate
 * entry point; the `overview-mode` testid stays stable for e2e.
 */
export default function OverviewMode() {
  return (
    <div data-testid="overview-mode" className="flex h-full w-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--line)] bg-black/30 px-2 py-1.5">
        <div className="flex-1" />
        <AnnotateTrigger />
      </div>
      <div className="relative min-h-0 flex-1">
        <OverviewSummary />
      </div>
    </div>
  )
}
