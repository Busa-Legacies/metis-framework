import type { AgentKind } from './types'

export type EffortLevel = 'low' | 'medium' | 'high' | 'extra-high' | 'max'

export const EFFORT_LEVELS: readonly EffortLevel[] = [
  'low',
  'medium',
  'high',
  'extra-high',
  'max',
] as const

export const DEFAULT_EFFORT_LEVEL: EffortLevel = 'medium'

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value)
}

export function coerceEffortLevel(value: unknown): EffortLevel {
  return isEffortLevel(value) ? value : DEFAULT_EFFORT_LEVEL
}

const CLAUDE_EFFORT_HINTS: Record<EffortLevel, string> = {
  low: 'Effort budget: LOW. Prefer the fastest viable answer. Skip exhaustive analysis. Do the minimum that satisfies the request.',
  medium: '',
  high: 'Effort budget: HIGH. Take extra time to analyze carefully. Verify key assumptions before answering. Prefer correctness over speed.',
  'extra-high': 'Effort budget: EXTRA-HIGH. Deep analysis with cross-checking and multiple passes. Verify each conclusion against the source. Bias toward thoroughness.',
  max: 'Effort budget: MAX. Maximum reasoning depth. Exhaustively verify edges, contradictions, and assumptions. Act as if a senior reviewer will audit every line.',
}

const CODEX_EFFORT_MAP: Record<EffortLevel, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  'extra-high': 'high',
  max: 'high',
}

/**
 * CLI flags to inject into a spawn for a given agent backend at the requested effort level.
 *
 * - claude: --append-system-prompt with an effort hint (claude CLI has no native effort flag).
 * - codex:  --effort <level>, mapping the workbench's 5 levels onto codex's 3 (low/medium/high).
 * - shell / python / gemini / custom / unknown: no-op (empty array).
 *
 * 'medium' is the workbench default and intentionally returns no flags for every backend so that
 * the default spawn behavior is unchanged when no effort is selected.
 */
export function effortFlagsForKind(kind: AgentKind, level: EffortLevel): string[] {
  switch (kind) {
    case 'claude': {
      const hint = CLAUDE_EFFORT_HINTS[level]
      if (!hint) return []
      return ['--append-system-prompt', `# Effort\n${hint}`]
    }
    case 'codex': {
      if (level === 'medium') return []
      return ['--effort', CODEX_EFFORT_MAP[level]]
    }
    case 'gemini':
    case 'shell':
    case 'python':
    case 'custom':
    default:
      return []
  }
}
