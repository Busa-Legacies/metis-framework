/**
 * Telegram-safe portfolio renderer.
 *
 * Spec: WORKBENCH_CEO_PRODUCT_MANAGEMENT_FLOW_SPEC_CLAUDE_20260509.md S2 / AC2.1–AC2.3.
 * QA gates: WORKBENCH_CEO_FLOW_QA_ACCEPTANCE_CLAUDE_20260509.md T-TGCKPT-3 / -4 / -5.
 *
 * Pure module: no fs, no network, no PTY. Deterministic output for a given input.
 */

export interface PortfolioSyncSnapshot {
  inRepo: boolean
  branch: string | null
  ahead: number
  behind: number
  dirtyCount: number
  untrackedCount: number
}

export interface PortfolioEvidenceCounts {
  reportsUnread: number
  reviewsOpen: number
  manualOverrides: number
}

export interface PortfolioWorkspaceRollup {
  workspaceId: string
  name: string
  sync: PortfolioSyncSnapshot
  inFlightAgents: number
  lastShipped: string | null
  nextAction: string | null
  evidenceCounts: PortfolioEvidenceCounts
}

export interface PortfolioRollup {
  generatedAt: string
  workspaces: PortfolioWorkspaceRollup[]
}

export interface RenderPortfolioOptions {
  filterToActionable?: boolean
}

function describeSync(sync: PortfolioSyncSnapshot): string {
  if (!sync.inRepo) return 'not in a git repo'
  const parts: string[] = []
  if (sync.branch) parts.push(`branch ${sync.branch}`)
  if (sync.ahead > 0 || sync.behind > 0) {
    parts.push(`${sync.ahead} ahead, ${sync.behind} behind`)
  }
  if (sync.dirtyCount > 0) parts.push(`${sync.dirtyCount} dirty`)
  if (sync.untrackedCount > 0) parts.push(`${sync.untrackedCount} untracked`)
  if (parts.length === 0) return 'clean'
  if (sync.dirtyCount === 0 && sync.untrackedCount === 0 && sync.ahead === 0 && sync.behind === 0) {
    return `${parts.join(', ')}, clean`
  }
  return parts.join(', ')
}

function describeWorkspace(ws: PortfolioWorkspaceRollup): string {
  const sync = describeSync(ws.sync)
  const flight =
    ws.inFlightAgents === 0
      ? 'no agents in flight'
      : ws.inFlightAgents === 1
        ? '1 agent in flight'
        : `${ws.inFlightAgents} agents in flight`
  const reports =
    ws.evidenceCounts.reportsUnread > 0
      ? `, ${ws.evidenceCounts.reportsUnread} unread report${ws.evidenceCounts.reportsUnread === 1 ? '' : 's'}`
      : ''
  const shipped = ws.lastShipped ? `, last shipped ${ws.lastShipped}` : ''
  return `${sync}, ${flight}${reports}${shipped}`
}

function compareWorkspaces(
  a: PortfolioWorkspaceRollup,
  b: PortfolioWorkspaceRollup,
): number {
  const aHas = a.nextAction ? 0 : 1
  const bHas = b.nextAction ? 0 : 1
  if (aHas !== bHas) return aHas - bHas
  if (a.name !== b.name) return a.name < b.name ? -1 : 1
  return a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0
}

/**
 * Render a portfolio rollup as a Telegram-safe plain-prose string.
 * Output is deterministic for a given input. Workspaces with a nextAction
 * are listed first (name asc), then quiet workspaces (name asc).
 */
export function renderPortfolioForTelegram(
  rollup: PortfolioRollup,
  options: RenderPortfolioOptions = {},
): string {
  const filtered = options.filterToActionable
    ? rollup.workspaces.filter((w) => w.nextAction)
    : rollup.workspaces.slice()
  if (filtered.length === 0) {
    return options.filterToActionable
      ? 'No workspaces with pending actions.'
      : 'No workspaces tracked.'
  }
  const ordered = filtered.sort(compareWorkspaces)
  const lines = ordered.map((ws) => {
    const status = describeWorkspace(ws)
    const next = ws.nextAction ? ws.nextAction : 'nothing pending'
    return `${ws.name} — ${status}. Next: ${next}.`
  })
  return lines.join('\n')
}

const FENCE_RE = /```/
const ATX_HEADER_RE = /^#{1,6}\s/m
const SETEXT_UNDERLINE_RE = /^[^\n]+\n(?:={3,}|-{3,})\s*$/m
const TABLE_DIVIDER_RE = /^\s*\|?\s*:?-{3,}/m
const TABLE_PIPE_ROW_RE = /^\s*[^|\n]*\|[^|\n]*\|[^\n]*$/m

/**
 * Throws if the string violates the Telegram-safe rendering contract:
 * no fenced code blocks, no ATX/Setext headers, no markdown tables.
 * Used by tests gating T-TGCKPT-3.
 */
export function assertTelegramSafe(text: string): void {
  if (FENCE_RE.test(text)) {
    throw new Error('telegram_unsafe: fenced code block detected')
  }
  if (ATX_HEADER_RE.test(text)) {
    throw new Error('telegram_unsafe: ATX header detected')
  }
  if (SETEXT_UNDERLINE_RE.test(text)) {
    throw new Error('telegram_unsafe: setext header underline detected')
  }
  if (TABLE_DIVIDER_RE.test(text)) {
    throw new Error('telegram_unsafe: table divider detected')
  }
  if (TABLE_PIPE_ROW_RE.test(text)) {
    throw new Error('telegram_unsafe: table pipe-row detected')
  }
}
