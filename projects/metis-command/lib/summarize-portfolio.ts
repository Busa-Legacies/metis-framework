/**
 * Wave-C1 portfolio summarization pipeline.
 *
 * Pure function: chains buildControlCenterSummary -> convertControlCenterToRollup ->
 * renderPortfolioForTelegram so the assistant `summarize_portfolio` tool and
 * future surfaces (Telegram, CLI brain) can produce a single Telegram-safe
 * portfolio rollup string from raw workspace + agent state.
 *
 * No fs, no network, no PTY — callers fetch state and pass it in.
 */

import {
  buildControlCenterSummary,
  type ControlCenterSummaryInput,
  type ControlCenterSummaryResponse,
} from './control-center-summary'
import {
  convertControlCenterToRollup,
  type ControlCenterToRollupOptions,
} from './control-center-to-rollup'
import {
  renderPortfolioForTelegram,
  type PortfolioRollup,
} from './portfolio-render'

export interface SummarizePortfolioInput
  extends Omit<ControlCenterSummaryInput, 'workspaceSelectors'> {
  workspaceFilter?: string
  actionableOnly?: boolean
  syncByWorkspace?: ControlCenterToRollupOptions['syncByWorkspace']
}

export interface SummarizePortfolioResult {
  text: string
  rollup: PortfolioRollup
  controlCenter: ControlCenterSummaryResponse
}

export function summarizePortfolio(
  input: SummarizePortfolioInput,
): SummarizePortfolioResult | { error: string } {
  const trimmedFilter =
    typeof input.workspaceFilter === 'string' ? input.workspaceFilter.trim() : ''
  const workspaceSelectors = trimmedFilter.length > 0 ? [trimmedFilter] : undefined

  const controlCenter = buildControlCenterSummary({
    workspaces: input.workspaces,
    agents: input.agents,
    workspaceSelectors,
    runsLimit: input.runsLimit,
    activeWorkspaceId: input.activeWorkspaceId,
    generatedAt: input.generatedAt,
    now: input.now,
    staleThresholdMs: input.staleThresholdMs,
    reportsLimit: input.reportsLimit,
    includeAcked: input.includeAcked,
    acks: input.acks,
    reports: input.reports,
    evidenceByWorkspace: input.evidenceByWorkspace,
  })
  if ('error' in controlCenter) return controlCenter

  const rollup = convertControlCenterToRollup(controlCenter, {
    syncByWorkspace: input.syncByWorkspace,
  })
  const text = renderPortfolioForTelegram(rollup, {
    filterToActionable: input.actionableOnly === true,
  })
  return { text, rollup, controlCenter }
}
