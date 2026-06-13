/**
 * Typed contract for the stable subset of the dashboard `/api/all` payload that
 * the Control Center Overview consumes. Field shapes verified against the live
 * payload on 2026-06-08 (Jay, 22 top-level keys). Only fields the React surface
 * actually reads are typed here; the rest stay under the index signature so we
 * never claim a contract we don't exercise (PLAN §7.2 contract-first).
 *
 * Keep this in sync with a fixture test before porting any new card (M3).
 */

export interface MetisSystem {
  cpu_pct: number
  ram_used_gb: number
  ram_total_gb: number
  ram_pct: number
  disk_used_gb: number
  disk_total_gb: number
  disk_pct: number
}

export interface MetisJay {
  gateway_running: boolean
  primary_model: string
}

export interface MetisOllamaModel {
  name: string
  size_gb: number
}

export interface MetisOllama {
  running: boolean
  models: MetisOllamaModel[]
}

export interface MetisBot {
  running: boolean
  pid: string
  mode: string
  strategy?: { name: string; fast_ma: number; slow_ma: number }
}

export type AlertLevel = 'critical' | 'warning' | 'info' | string
export interface MetisAlert {
  level: AlertLevel
  msg: string
  source: string
}

export interface MetisRateWindow {
  pct: number
  resets_at: string
  as_of_age_s: number
}

/** Per-provider usage. five_hour/seven_day present for Claude; codex may omit. */
export interface MetisProviderUsage {
  total_cost?: number
  total_requests?: number
  daily_budget?: number
  budget_pct?: number
  five_hour?: MetisRateWindow
  seven_day?: MetisRateWindow
}

/** Codex usage is token/session-based rather than window-pct-based. */
export interface MetisCodexUsage {
  sessions_today?: number
  tokens_today?: number
  /**
   * Soft local planning target, not an account/provider enforced cap.
   * Older payloads may still expose daily_token_target/token_pct; prefer these
   * fields when present so the UI does not imply a real Codex rate limit.
   */
  soft_token_target?: number
  target_pct?: number
  limit_known?: boolean
  limit_note?: string
  daily_token_target?: number
  token_pct?: number
  source?: string
  note?: string
  models?: {
    model: string
    sessions: number
    tokens: number
    input_tokens?: number
    cached_input_tokens?: number
    output_tokens?: number
    reasoning_output_tokens?: number
  }[]
  recent_sessions?: {
    session_id: string
    short_id: string
    model: string
    cwd?: string | null
    tokens: number
    total_tokens?: number
    updated_at?: string | null
  }[]
}

export interface MetisRateLimits {
  claude?: MetisProviderUsage
  codex?: MetisCodexUsage
}

export interface MetisMemory {
  agent: string
  chunks_indexed: number
  files_indexed: number
  reranker_available: boolean
  memory_dir: string
  memory_files: string[]
  upgrade?: { current_tier: number; file_count: number; threshold_next: number; files_until_upgrade: number; message: string }
  index_built_at?: string | null
  index_git_hash?: string | null
}

export interface MetisRemote {
  tailscale_ip: string
  ssh: { running: boolean; command: string; attach: string }
  ttyd: { running: boolean; url: string; credentials: string }
  dashboard: { url: string }
  tmux_sessions: string
}

export interface MetisPriorityItem {
  taskId: string
  title: string
  priority: string
  state: string
  goals?: string[]
  system?: number | null
  score?: number
}

/** A goal/milestone with rolled-up task counts (drives Work Graph progress). */
export interface MetisGoal {
  id: string
  title: string
  domain?: string | null
  system: number
  weight: number
  marker: string
  active: number
  in_progress: number
  blocked: number
  done: number
}

export interface MetisPriorities {
  goals: MetisGoal[]
  next: MetisPriorityItem[]
  by_system: Record<string, MetisPriorityItem[]>
  systems: Record<string, string>
  orphans: MetisPriorityItem[]
  blocked: MetisPriorityItem[]
  blocked_count: number
  active_total: number
  error?: string | null
}

/** Per-project rollup from the task board. */
export interface MetisTaskSummary {
  project: string
  priority: string
  status: string
  next_up: string
}

export interface MetisTasks {
  summary: MetisTaskSummary[]
  sections: unknown[]
}

/** An active agent lease (checkout + fence token) from /api/leases. */
export interface MetisLease {
  taskId: string | null
  title: string | null
  agent: string | null
  status: string
  fenceToken: number | null
  branch: string | null
  session: string | null
  leaseExpiresAt: string | null
  lastRenewedAt: string | null
}

export interface MetisLeasesResponse {
  leases: MetisLease[]
  count: number
  fenceCounter?: number
  updatedAt?: string
  error?: string
}

export interface MetisAll {
  ts: string
  system: MetisSystem
  jay: MetisJay
  ollama: MetisOllama
  bot: MetisBot
  alerts: MetisAlert[]
  ratelimits: MetisRateLimits
  priorities: MetisPriorities
  tasks: MetisTasks
  memory: MetisMemory
  remote: MetisRemote
  /** Remaining /api/all keys (github, finance, garmin, …) — untyped until a card needs them. */
  [key: string]: unknown
}

// ── Governed Task Board (/api/tasks/governed) ─────────────────────────────────

export interface MetisGoverndTask {
  taskId: string
  title: string
  state: string
  priority: string
  owner: string | null
  agent: string | null
  machine: string | null
  project: string
  summary: string | null
  why: string | null
  how: string | null
  firstStep: string | null
  currentStep: string | null
  blocker: string | null
  nextAction: string | null
  nextDecisionPoint?: string | null
  expectedArtifact: string | null
  verificationMethod: string | null
  verificationState?: string | null
  updatedAt: string
  revision: number
  milestone: { id: string; title: string } | null
  isOpen: boolean
  /** Notion-parity action-type badge (only set on /api/inbox items). */
  actionType?: string
  /** Done-gate readiness (only set on /api/lines items). */
  doneGate?: MetisDoneGate
  /** Curated decision frame (only set on /api/inbox decide-bucket items). */
  decisionContext?: MetisDecisionContext
  /** Structured one-tap decision options (#323) — SoT both surfaces render from. */
  decisionOptions?: MetisDecisionOption[]
  /** Agent's recommended option (key + why), starred in the UI. */
  recommendation?: string | null
  /** Resolved outcome — set once Ant decides; closes the decision-point. */
  decision?: string | null
  /** Ranked review material — plan/spec/design to open in-card (decide + verify items). */
  material?: MetisMaterial
}

/** One tappable decision option (#323). */
export interface MetisDecisionOption {
  key: string
  label: string
  detail?: string | null
}

/** A single reviewable file attached to an inbox item. */
export interface MetisMaterialFile {
  path: string
  label: string
  kind: 'markdown' | 'image' | 'text'
}

/** Ranked review material for an inbox item; `primary` is auto-loaded on open. */
export interface MetisMaterial {
  primary: string | null
  files: MetisMaterialFile[]
}

/** A heading in a doc's outline. */
export interface MetisDocHeading {
  level: number
  text: string
}

/** A named, decision-relevant section pulled from a doc. */
export interface MetisDocSection {
  heading: string
  body: string
}

/**
 * Condensed brief for a markdown doc (server-extracted, no LLM): the outline plus
 * the bodies of decision-driving sections (Decision/Options/Recommendation/Why…)
 * so an inbox card can be decided from without opening the full file (#240).
 */
export interface MetisDocBrief {
  outline: MetisDocHeading[]
  sections: MetisDocSection[]
  tldr: string | null
}

/** Result of GET /api/file — a repo file served for inline review. */
export interface MetisFileContent {
  ok: boolean
  error?: string
  path?: string
  kind?: 'markdown' | 'text' | 'image'
  content?: string
  dataUrl?: string
  truncated?: boolean
  brief?: MetisDocBrief
}

/**
 * Curated frame for a task decision-point (#240 review redesign). Server resolves
 * the raw decision text into exactly what's needed to make the call: the question,
 * the tight why-context, resolved task references (#NNN → title + state), and any
 * spec/file paths the decision touches — so the detail view can show only relevant
 * context instead of dumping every task field.
 */
export interface MetisDecisionContext {
  /** The decision question itself (normalized nextDecisionPoint). */
  question: string | null
  /** Tight context — the task's why (preferred) or summary. */
  context: string | null
  /** Full summary, when distinct from context. */
  summary: string | null
  /** Resolved #NNN task references appearing in the decision text. */
  refs: { taskId: string; title: string | null; state: string | null }[]
  /** Spec/file paths the decision references (docs/…, projects/…, scripts/…). */
  specs: string[]
}

// ── Lines of work (/api/lines) ────────────────────────────────────────────────

export interface MetisDoneGate {
  ready: boolean
  checks: { label: string; ok: boolean }[]
}

/** A project summary in the drill picker. */
export interface MetisLineSummary {
  slug: string
  name: string
  goal: string | null
  domain?: string | null
  domainLabel?: string | null
  campaign?: string | null
  campaignName?: string | null
  priority: string
  status: string
  progress: number | null
  shipped: number | null
  milestonesTotal: number | null
  openCount: number
}

export interface MetisLinesIndex {
  projects: MetisLineSummary[]
}

export interface MetisLineMilestone {
  id: string
  title: string
  status: string
  doneWhen: string | null
  weight: number | null
  progress: number
  taskCount: number
  openCount: number
  tasks: MetisGoverndTask[]
}

export interface MetisLineLease {
  agent: string | null
  fenceToken: number | null
  status: string | null
  session: string | null
}

export interface MetisLineDetail {
  project: {
    slug: string
    name: string
    goal: string | null
    domain?: string | null
    domainLabel?: string | null
    campaign?: string | null
    campaignName?: string | null
    priority: string
    status: string
    doneWhen: string | null
    progress: number | null
    shipped: number | null
    milestonesTotal: number | null
    openCount: number
  }
  milestones: MetisLineMilestone[]
  unassigned: MetisGoverndTask[]
  leases: Record<string, MetisLineLease>
}

// ── Domain coverage (/api/domain-coverage) ──────────────────────────────────

export interface MetisDomainEntry {
  domain: string
  label: string
  active_count: number
  paused_blocked_count: number
  evergreen_count: number
  campaigns: string[]
  neglected: boolean
  stale_signal: boolean
}

export interface MetisDomainCoverage {
  domains: MetisDomainEntry[]
}

// ── Operator inbox (/api/inbox) ───────────────────────────────────────────────

/** A formal decision record from decisions.json (decide.py). */
export interface MetisDecision {
  decision_id: string
  title: string
  status: string
  options: string[]
  recommended?: string | null
  context?: string | null
  task_context?: string | null
  criteria?: string[]
  created_at?: string
}

export interface MetisInboxBuckets {
  decide: MetisGoverndTask[]
  verify: MetisGoverndTask[]
  unblock: MetisGoverndTask[]
  waiting: MetisGoverndTask[]
}

export interface MetisInbox {
  decisions: MetisDecision[]
  buckets: MetisInboxBuckets
  focus: {
    focusSummary: string | null
    waitingOnAnt: boolean
    blockerSummary: string | null
    nextSteps: string[]
  }
  counts: { decide: number; verify: number; unblock: number; waiting: number; decisions: number; total: number }
}

export interface MetisGoverndProject {
  slug: string
  name: string
  goal: string | null
  priority: string
  status: string
  progress: number | null
  shipped: number
  milestonesTotal: number
  openCount: number
  taskCount: number
  tasks: MetisGoverndTask[]
}

export interface MetisGoverned {
  projects: MetisGoverndProject[]
  stateCounts: Record<string, number>
  openTotal: number
  doneTotal: number
  total: number
  includeDone: boolean
}

// ── Task routing preview (/api/task-routing/plan) ────────────────────────────

export interface MetisTaskRoutePlan {
  task: Pick<MetisGoverndTask, 'taskId' | 'title' | 'state' | 'priority' | 'project' | 'summary' | 'nextAction' | 'expectedArtifact' | 'verificationMethod'>
  action: {
    kind: string
    label: string
    canStart: boolean
    canResume: boolean
  }
  recommendation: {
    kind: string
    ownerRole: string
    lane: string
    confidence: number
    reason: string
  }
  risk: {
    tier: string
    approvalMode: string
    reasons: string[]
  }
  activeLeases: MetisLease[]
  transition: {
    from: string
    legalNextStates: string[]
    defaultNextState: string | null
  }
  missionPacket: {
    id: string
    title: string
    goal: string
    lanes: {
      id: string
      role: string
      engine: string
      lane?: string
      riskTier?: string
      approval?: string
      scope?: string[]
      prompt?: string
    }[]
    constraints?: string[]
    acceptanceCriteria?: string[]
    reviewGate?: string
  }
  workbenchSpawn: {
    kind: string
    name: string
    cwd: string
    role: string
    taskId: string
    initialPrompt: string
    requiresConfirmation: boolean
    enabled: boolean
  }
  commands: Record<string, string[]>
  readOnly: boolean
  generatedAt: string
}
