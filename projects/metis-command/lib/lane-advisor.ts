import type { AgentKind, AgentRole } from './types'

export interface LaneAdvisorInput {
  title?: string
  description?: string
  files?: string[]
  readOnly?: boolean
  needsReview?: boolean
  needsTests?: boolean
  needsImplementation?: boolean
  needsUi?: boolean
  needsShell?: boolean
  needsDocsLookup?: boolean
  preferredKind?: AgentKind
  preferredRole?: AgentRole
}

export interface LaneAdvisorRecommendation {
  kind: AgentKind
  ownerRole: AgentRole
  reason: string
  confidence: 'low' | 'medium' | 'high'
}

const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|json|css|scss|html|mdx|py|sh|c|cc|cpp|h|hpp|go|rs|java|kt|swift)$/i
const UI_EXTENSIONS = /\.(tsx|jsx|css|scss|html|mdx)$/i
const TEST_EXTENSIONS = /(^|\/)(tests?|__tests__)\/|(\.|-)(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/i

function text(input: LaneAdvisorInput): string {
  return `${input.title ?? ''} ${input.description ?? ''}`.toLowerCase()
}

function hasAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle))
}

function hasTerm(haystack: string, term: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${term}([^a-z0-9]|$)`, 'i').test(haystack)
}

function fileMatches(files: string[] | undefined, pattern: RegExp): boolean {
  return (files ?? []).some((file) => pattern.test(file))
}

function fileCount(files: string[] | undefined): number {
  return files?.length ?? 0
}

function withOverride(input: LaneAdvisorInput, base: LaneAdvisorRecommendation): LaneAdvisorRecommendation {
  if (!input.preferredKind && !input.preferredRole) return base
  const kind = input.preferredKind ?? base.kind
  const ownerRole = input.preferredRole ?? base.ownerRole
  const override = [
    input.preferredKind ? `kind=${input.preferredKind}` : '',
    input.preferredRole ? `role=${input.preferredRole}` : '',
  ].filter(Boolean).join(', ')
  return {
    kind,
    ownerRole,
    confidence: 'medium',
    reason: `${base.reason}; user override applied (${override})`,
  }
}

export function recommendMissionLane(input: LaneAdvisorInput): LaneAdvisorRecommendation {
  const words = text(input)
  const files = input.files ?? []
  const manyFiles = fileCount(files) >= 3
  const sourceFiles = fileMatches(files, SOURCE_EXTENSIONS)
  const uiFiles = fileMatches(files, UI_EXTENSIONS)
  const testFiles = fileMatches(files, TEST_EXTENSIONS)
  const reviewTerms = hasAny(words, ['review', 'qa', 'audit', 'critique', 'verify', 'regression'])
  const scoutTerms = hasAny(words, ['read-only', 'read only', 'architecture', 'research', 'inspect', 'map ', 'spec', 'contract'])
  const shellTerms = hasAny(words, ['shell', 'terminal', 'script', 'command', 'logs', 'grep', 'rg ', 'filesystem'])
  const docsTerms = hasAny(words, ['openai docs', 'api docs', 'documentation lookup', 'latest docs', 'gemini'])
  const uiTerms = ['ui', 'ux', 'frontend', 'react', 'visual', 'layout', 'component', 'screenshot'].some((term) =>
    hasTerm(words, term),
  )
  const implementationTerms = hasAny(words, ['implement', 'build', 'fix', 'patch', 'edit', 'refactor', 'test'])

  let base: LaneAdvisorRecommendation

  if (input.needsShell || shellTerms) {
    base = {
      kind: 'shell',
      ownerRole: 'scout',
      confidence: 'high',
      reason: 'terminal/log/script work is best isolated in a shell lane',
    }
  } else if (input.needsDocsLookup || docsTerms) {
    base = {
      kind: 'gemini',
      ownerRole: 'scout',
      confidence: 'medium',
      reason: 'documentation or broad source lookup maps to a scout lane with external-research bias',
    }
  } else if (input.needsReview || reviewTerms) {
    base = {
      kind: 'claude',
      ownerRole: 'reviewer',
      confidence: uiFiles || uiTerms ? 'high' : 'medium',
      reason: uiFiles || uiTerms
        ? 'UI review and product critique map to Claude as Shield reviewer'
        : 'review-only work should be separate from the builder lane',
    }
  } else if (input.readOnly || scoutTerms) {
    base = {
      kind: 'claude',
      ownerRole: 'scout',
      confidence: 'medium',
      reason: 'read-only architecture and source inspection map to a Scout lane',
    }
  } else if (input.needsUi || uiTerms || uiFiles) {
    base = {
      kind: input.needsImplementation || implementationTerms || sourceFiles ? 'codex' : 'claude',
      ownerRole: input.needsImplementation || implementationTerms || sourceFiles ? 'builder' : 'reviewer',
      confidence: 'medium',
      reason: input.needsImplementation || implementationTerms || sourceFiles
        ? 'frontend source edits with tests map to Codex as Forge builder'
        : 'visual UX judgment maps to Claude as Shield reviewer',
    }
  } else if (input.needsImplementation || input.needsTests || implementationTerms || sourceFiles || testFiles || manyFiles) {
    base = {
      kind: 'codex',
      ownerRole: 'builder',
      confidence: manyFiles || testFiles || input.needsTests ? 'high' : 'medium',
      reason: manyFiles || testFiles || input.needsTests
        ? 'multi-file implementation or test work maps to Codex as Forge builder'
        : 'source patch work maps to Codex as Forge builder',
    }
  } else {
    base = {
      kind: 'claude',
      ownerRole: 'coordinator',
      confidence: 'low',
      reason: 'ambiguous work defaults to a coordinator lane until scope is clearer',
    }
  }

  return withOverride(input, base)
}

export function recommendLaneName(input: LaneAdvisorInput): string {
  const rec = recommendMissionLane(input)
  const role = rec.ownerRole[0].toUpperCase() + rec.ownerRole.slice(1)
  return `${role} ${rec.kind}`
}
