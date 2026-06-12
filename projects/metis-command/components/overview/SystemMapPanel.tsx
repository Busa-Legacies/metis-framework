'use client'

import { useState } from 'react'
import { useMetisAll } from '@/lib/use-metis-all'
import { useControlCenterNav } from '@/lib/control-center-nav'
import type { MetisGoal } from '@/lib/metis-api-types'

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  cyan:    '#34d3ff', cyanDim: 'rgba(52,211,255,0.12)', cyanBorder: 'rgba(52,211,255,0.3)',
  amber:   '#f59e0b', ambDim:  'rgba(245,158,11,0.12)',  ambBorder:  'rgba(245,158,11,0.3)',
  violet:  '#a78bfa', violDim: 'rgba(167,139,250,0.12)', violBorder: 'rgba(167,139,250,0.3)',
  emerald: '#34d399', emeDim:  'rgba(52,211,153,0.12)',  emeBorder:  'rgba(52,211,153,0.3)',
  blue:    '#60a5fa', bluDim:  'rgba(96,165,250,0.12)',  bluBorder:  'rgba(96,165,250,0.3)',
  pink:    '#f472b6',
  green:   '#34d399',
  text:    '#e2e8f0',
  textDim: 'rgba(148,163,184,0.75)',
  muted:   'rgba(148,163,184,0.45)',
  bg:      'rgba(8,13,24,0.80)',
  bgDark:  'rgba(3,6,14,0.90)',
  border:  'rgba(255,255,255,0.07)',
}

// ── System layer data ─────────────────────────────────────────────────────────

const LAYERS = [
  {
    id: 'client',
    label: 'Client Layer',
    color: C.violet,
    dim: C.violDim,
    border: C.violBorder,
    y: 0,
    nodes: ['Metis Command', 'Claude Code CLI', 'Mobile Browser'],
    detail: 'Entry points for human interaction. Metis Command is the Electron + Next.js control center. Claude Code CLI drives autonomous work on Jarry. The mobile browser accesses the FastAPI dashboard on Jay.',
    components: [
      { id: 'metis-command', label: 'Metis Command', desc: 'Electron + Next.js cockpit running on Jay (the always-on host). All modes feed from /api/all; reachable from any device over Tailscale.' },
      { id: 'claude-code', label: 'Claude Code CLI', desc: 'Orchestrator. Reads tasks, dispatches to Jay lanes, applies output, commits under git-lock. Running in tmux session on Jarry.' },
      { id: 'mobile', label: 'Mobile / Browser', desc: 'Tailscale-accessible dashboard at Jay :8000. Read-only view of bot status, tasks, portfolio.' },
    ],
  },
  {
    id: 'orchestration',
    label: 'Orchestration (Jarry)',
    color: C.cyan,
    dim: C.cyanDim,
    border: C.cyanBorder,
    y: 1,
    nodes: ['dispatch', 'session-lifecycle', 'git-auto-sync', 'hooks', 'task-system', 'memory'],
    detail: 'Jarry runs the orchestration layer. dispatch selects lanes × engines. session-lifecycle manages the A→B→C→D state machine. git-auto-sync commits every 15 min. Hooks enforce protocol at every Claude stop/start.',
    components: [
      { id: 'dispatch', label: 'dispatch CLI', desc: 'Routes tasks: role (forge/scout/shield/echo/hermes/curator) × engine (qwen-shallow→sonnet-standard). Enforces --risk/--mutation gates. Lives at ~/.local/bin/dispatch.' },
      { id: 'session-lifecycle', label: 'session-lifecycle', desc: 'LaunchAgent daemon. Reads session-registry, applies A/A2→B→C→D transitions. Kills idle sessions, closes tmux windows, runs sync-session.sh before kill.' },
      { id: 'git-sync', label: 'git-auto-sync', desc: 'Commits+pushes dirty tracked files every 15 min under git-lock.sh. Handles fenceCounter-merge for active-checkouts.json conflicts. Never force-pushes.' },
      { id: 'hooks', label: 'Hook system', desc: 'UserPromptSubmit, Stop, and PreToolUse hooks inject context, enforce sign-off blocks, guard file checkouts, and trigger auto-checkpoint on new commits.' },
      { id: 'task-system', label: 'Task system', desc: 'tasks.json is canonical. task-queue.md is a projection. agent-work.py claim-next atomically selects + claims. fenceCounter fencing prevents stale-writer races.' },
      { id: 'memory', label: 'Memory / Context', desc: 'Tiered JIT context: CLAUDE.md kernel + Router + packs (design/process rules) + session working-context.md. ClaudeCode/memory/ for cross-session durable facts.' },
    ],
  },
  {
    id: 'intelligence',
    label: 'Intelligence (Jay)',
    color: C.blue,
    dim: C.bluDim,
    border: C.bluBorder,
    y: 2,
    nodes: ['gateway :18789', 'Ollama :11434', 'forge', 'scout', 'shield', 'echo', 'hermes', 'curator'],
    detail: 'Jay is the always-on model host. OpenClaw gateway manages lane sessions. Ollama serves qwen3-coder:30b (all 6 lanes share one resident model). Dashboard FastAPI serves /api/all for all Metis Command data.',
    components: [
      { id: 'gateway', label: 'OpenClaw Gateway :18789', desc: 'Receives dispatch requests over Tailscale. Manages embedded sessions, enforces 120s idle timeout, routes to Ollama. State stored in session JSONL files.' },
      { id: 'ollama', label: 'Ollama :11434', desc: 'Serves qwen3-coder:30b on Jay 64GB M1 Max. All 6 lanes share one resident model — no reload thrash. 5-min KV-cache TTL; use --timeout 300 on dispatch.' },
      { id: 'forge', label: 'forge lane', desc: 'Code generation, drafts, config, boilerplate, tests, docs. Default lane for implementation tasks.' },
      { id: 'scout', label: 'scout lane', desc: 'Research, doc reading, summarisation, spec drafting, pattern search. Times out on 5+ category prompts — split or use WebSearch.' },
      { id: 'shield', label: 'shield lane', desc: 'Code review, QA, security audit, pre-commit check. Returns approve/iterate/reject + findings.' },
      { id: 'echo', label: 'echo lane', desc: 'Jay-local memory writes, working-context updates, daily logs. Echoes input when prompt >~10 lines — keep prompts short.' },
      { id: 'hermes', label: 'hermes lane', desc: 'Multi-step task decomposition → queue-runner-ready sub-task list. Outputs structured JSON task arrays.' },
      { id: 'curator', label: 'curator lane', desc: 'Automated quality gate. Reads forge/echo output, returns is_artifact verdict (false → iterate). Three-layer task gate.' },
    ],
  },
  {
    id: 'persistence',
    label: 'Persistence Layer',
    color: C.emerald,
    dim: C.emeDim,
    border: C.emeBorder,
    y: 3,
    nodes: ['GitHub / git', 'tasks.json', 'leases', 'session transcripts', 'SQLite'],
    detail: 'All durable state. Git is the source of truth for code and config. tasks.json owns the task queue. active-checkouts.json fences concurrent writes. Session JSONL transcripts persist in ~/.claude/projects.',
    components: [
      { id: 'github', label: 'GitHub / git', desc: 'metis-os is the mono-repo for all infrastructure. anthonyabusa.github.io is the personal site. git-lock.sh serialises all commits. Auto-sync daemon pushes every 15 min.' },
      { id: 'tasks', label: 'tasks.json + OPEN_TASKS.md', desc: 'tasks.json is the canonical task queue (what/why/how, state machine). OPEN_TASKS.md is a human-readable projection. free-work.py aggregates leases + tasks for conflict-free pickup.' },
      { id: 'leases', label: 'Lease / fencing', desc: 'active-checkouts.json with fenceCounter. Kleppmann fencing token prevents stale-writer races. git merge driver keeps the highest fenceCounter on sync conflicts.' },
      { id: 'transcripts', label: 'Session transcripts', desc: 'JSONL files in ~/.claude/projects/. session-registry.py rebuilds live state each cycle by scanning these. session-lifecycle.py drives A→B→C→D transitions from them.' },
      { id: 'db', label: 'SQLite (personal.db)', desc: 'Local-only personal data: todos, calendar cache, finance snapshots. Lives at projects/dashboard/personal.db. Never committed to git.' },
    ],
  },
  {
    id: 'integrations',
    label: 'Integrations',
    color: C.amber,
    dim: C.ambDim,
    border: C.ambBorder,
    y: 4,
    nodes: ['ClickUp', 'MS365', 'Notion', 'Discord', 'Kraken API'],
    detail: 'External services connected to the dashboard /api/all data plane. ClickUp drives Navore Market task surfaces. MS365 syncs email+calendar via a headless token on Jay. Discord receives alert pushes.',
    components: [
      { id: 'clickup', label: 'ClickUp', desc: 'Navore Market workspace tasks. Synced via CLICKUP_TOKEN env on Jay dashboard. Navore professional overlay in Metis Command reads ops_tasks + ms365 slices.' },
      { id: 'ms365', label: 'MS365 (Jay-only)', desc: 'Email + calendar cache on Jay via headless token. 15-min stale threshold. Metis Command shows count summaries; full content in the dashboard.' },
      { id: 'notion', label: 'Notion', desc: 'Command Center unified work DB (ds 6a82d8f4). Blocking To-Dos page auto-synced daily. Writing fold-back loop triggers on Status=Edited. MCP server available.' },
      { id: 'discord', label: 'Discord alerts', desc: 'Alerts push to Discord → phone (Jay is headless, never Jarry screen). Session lifecycle events, bot errors, and critical health alerts route here.' },
      { id: 'kraken', label: 'Kraken API', desc: 'Crypto trading bot. Alpha validation harness gates all strategies (DSR/PSR gate — no strategy has passed yet). #243 momentum-verify is the next open lever.' },
    ],
  },
]

type LayerDef = typeof LAYERS[number]
type ComponentDef = LayerDef['components'][number]

const LANE_COLORS: Record<string, string> = {
  forge: C.cyan, scout: C.violet, shield: C.emerald, echo: C.amber, hermes: C.blue, curator: C.pink,
}

// ── View stack types ──────────────────────────────────────────────────────────
type Frame =
  | { kind: 'root' }
  | { kind: 'layer'; layerId: string }
  | { kind: 'component'; layerId: string; componentId: string }
  | { kind: 'goal'; goalId: string }
  | { kind: 'task-breakdown'; goalId: string }
  | { kind: 'process-step'; stepId: string }

// ── Helpers ───────────────────────────────────────────────────────────────────
function goalPct(g: MetisGoal) {
  const t = g.active + g.in_progress + g.blocked + g.done
  return t === 0 ? 0 : Math.round((g.done / t) * 100)
}

function goalBarColor(g: MetisGoal) {
  if (g.blocked > 0) return C.amber
  const t = g.active + g.in_progress + g.blocked + g.done
  if (t > 0 && g.done === t) return C.green
  return C.cyan
}

// ── Shared UI ─────────────────────────────────────────────────────────────────
function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'rgba(255,255,255,0.04)',
        border: `1px solid ${C.border}`,
        color: C.textDim,
        fontSize: 10,
        padding: '3px 10px',
        borderRadius: 5,
        cursor: 'pointer',
        fontFamily: 'SF Mono, Fira Code, monospace',
        letterSpacing: '0.05em',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        transition: 'all 0.15s ease',
        marginBottom: 12,
      }}
    >
      ← {label}
    </button>
  )
}

function Pill({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      background: `${color}18`, border: `1px solid ${color}40`,
      color, fontSize: 8, padding: '2px 7px', borderRadius: 3,
      fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' as const,
    }}>
      {label}
    </span>
  )
}

function DrillCard({
  label, sublabel, right, color, onClick, accent,
}: {
  label: string
  sublabel?: string
  right?: React.ReactNode
  color?: string
  onClick: () => void
  accent?: boolean
}) {
  const [hov, setHov] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        width: '100%',
        background: hov ? (color ? `${color}0d` : 'rgba(255,255,255,0.04)') : C.bg,
        border: `1px solid ${hov && color ? color + '50' : (accent && color ? color + '35' : C.border)}`,
        borderRadius: 7,
        padding: '10px 12px',
        cursor: 'pointer',
        transition: 'all 0.15s ease',
        textAlign: 'left' as const,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      {color && (
        <span style={{ width: 3, height: 28, borderRadius: 2, background: color, flexShrink: 0, opacity: 0.8 }} />
      )}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', color: C.text, fontSize: 11, fontWeight: 600 }}>{label}</span>
        {sublabel && <span style={{ display: 'block', color: C.textDim, fontSize: 10, marginTop: 2 }}>{sublabel}</span>}
      </span>
      {right}
      <span style={{ color: C.muted, fontSize: 12, flexShrink: 0 }}>›</span>
    </button>
  )
}

// ── Architecture topology graph ───────────────────────────────────────────────
// Real node-edge system diagram: machines as zones, components as nodes,
// actual data flows as edges. Clicking a node drills into its component view;
// clicking a zone header drills into the layer.

type GNode = {
  id: string; label: string; x: number; y: number; w: number; h: number
  color: string; layer: string; comp: string; small?: boolean
}

const GN: GNode[] = [
  // JARRY zone — orchestration only (Metis Command runs on Jay)
  { id: 'claude-code',   label: 'Claude Code',   x: 24,  y: 58,  w: 128, h: 34, color: C.violet,  layer: 'client',        comp: 'claude-code' },
  { id: 'dispatch',      label: 'dispatch',      x: 186, y: 60,  w: 100, h: 30, color: C.cyan,    layer: 'orchestration', comp: 'dispatch' },
  { id: 'hooks',         label: 'hooks',         x: 24,  y: 116, w: 76,  h: 26, color: C.cyan,    layer: 'orchestration', comp: 'hooks', small: true },
  { id: 'lifecycle',     label: 'lifecycle',     x: 112, y: 116, w: 78,  h: 26, color: C.cyan,    layer: 'orchestration', comp: 'session-lifecycle', small: true },
  { id: 'sync-jarry',    label: 'auto-sync',     x: 202, y: 116, w: 84,  h: 26, color: C.cyan,    layer: 'orchestration', comp: 'git-sync', small: true },
  { id: 'memory',        label: 'memory/ctx',    x: 24,  y: 158, w: 96,  h: 26, color: C.cyan,    layer: 'orchestration', comp: 'memory', small: true },
  // JAY zone — always-on host: Metis Command, gateway, Ollama, lanes, data plane
  { id: 'metis-command', label: 'Metis Command', x: 444, y: 56,  w: 126, h: 28, color: C.violet,  layer: 'client',       comp: 'metis-command' },
  { id: 'gateway',       label: 'gateway :18789', x: 444, y: 98,  w: 126, h: 30, color: C.blue,    layer: 'intelligence', comp: 'gateway' },
  { id: 'ollama',        label: 'Ollama :11434',  x: 444, y: 146, w: 126, h: 32, color: C.blue,    layer: 'intelligence', comp: 'ollama' },
  { id: 'forge',         label: 'forge',          x: 596, y: 98,  w: 62, h: 22, color: C.cyan,    layer: 'intelligence', comp: 'forge',   small: true },
  { id: 'scout',         label: 'scout',          x: 664, y: 98,  w: 62, h: 22, color: C.violet,  layer: 'intelligence', comp: 'scout',   small: true },
  { id: 'shield',        label: 'shield',         x: 596, y: 128, w: 62, h: 22, color: C.emerald, layer: 'intelligence', comp: 'shield',  small: true },
  { id: 'echo',          label: 'echo',           x: 664, y: 128, w: 62, h: 22, color: C.amber,   layer: 'intelligence', comp: 'echo',    small: true },
  { id: 'hermes',        label: 'hermes',         x: 596, y: 158, w: 62, h: 22, color: C.blue,    layer: 'intelligence', comp: 'hermes',  small: true },
  { id: 'curator',       label: 'curator',        x: 664, y: 158, w: 62, h: 22, color: C.pink,    layer: 'intelligence', comp: 'curator', small: true },
  { id: 'dashboard',     label: '/api/all :8000', x: 444, y: 196, w: 126, h: 30, color: C.blue,   layer: 'client',       comp: 'mobile' },
  { id: 'sync-jay',      label: 'auto-sync',      x: 444, y: 242, w: 96,  h: 26, color: C.blue,   layer: 'orchestration', comp: 'git-sync', small: true },
  { id: 'bot',           label: 'trading bot',    x: 560, y: 242, w: 96,  h: 26, color: C.amber,  layer: 'integrations',  comp: 'kraken', small: true },
  // Persistence zone
  { id: 'github',        label: 'GitHub',         x: 30,  y: 332, w: 100, h: 32, color: C.emerald, layer: 'persistence', comp: 'github' },
  { id: 'tasks',         label: 'tasks.json',     x: 152, y: 332, w: 100, h: 30, color: C.emerald, layer: 'persistence', comp: 'tasks' },
  { id: 'leases',        label: 'leases',         x: 270, y: 332, w: 76,  h: 30, color: C.emerald, layer: 'persistence', comp: 'leases' },
  { id: 'transcripts',   label: 'transcripts',    x: 152, y: 378, w: 110, h: 26, color: C.emerald, layer: 'persistence', comp: 'transcripts', small: true },
  // Integrations zone
  { id: 'clickup',       label: 'ClickUp',        x: 462, y: 332, w: 80, h: 26, color: C.amber, layer: 'integrations', comp: 'clickup', small: true },
  { id: 'ms365',         label: 'MS365',          x: 552, y: 332, w: 70, h: 26, color: C.amber, layer: 'integrations', comp: 'ms365',  small: true },
  { id: 'notion',        label: 'Notion',         x: 632, y: 332, w: 70, h: 26, color: C.amber, layer: 'integrations', comp: 'notion', small: true },
  { id: 'discord',       label: 'Discord',        x: 462, y: 372, w: 80, h: 26, color: C.amber, layer: 'integrations', comp: 'discord', small: true },
  { id: 'kraken',        label: 'Kraken',         x: 552, y: 372, w: 70, h: 26, color: C.amber, layer: 'integrations', comp: 'kraken', small: true },
]

// from → to (+ optional label, bidirectional flag)
const GE: { f: string; t: string; label?: string; bidir?: boolean }[] = [
  // Client → data plane / sessions
  { f: 'metis-command', t: 'dashboard' },
  { f: 'metis-command', t: 'gateway', label: 'assistant' },
  // Dispatch chain: gateway runs the lane sessions; lanes call Ollama for inference
  { f: 'claude-code',   t: 'dispatch' },
  { f: 'dispatch',      t: 'gateway', label: 'tailscale' },
  { f: 'gateway',       t: 'forge' }, { f: 'gateway', t: 'scout' }, { f: 'gateway', t: 'shield' },
  { f: 'gateway',       t: 'echo' },  { f: 'gateway', t: 'hermes' }, { f: 'gateway', t: 'curator' },
  { f: 'forge',         t: 'ollama' }, { f: 'scout', t: 'ollama' }, { f: 'shield', t: 'ollama' },
  { f: 'echo',          t: 'ollama' }, { f: 'hermes', t: 'ollama' }, { f: 'curator', t: 'ollama' },
  // Orchestration around Claude Code
  { f: 'hooks',         t: 'claude-code' },
  { f: 'lifecycle',     t: 'claude-code', label: 'reap' },
  { f: 'memory',        t: 'claude-code', bidir: true },
  { f: 'claude-code',   t: 'sync-jarry', label: 'commits' },
  // Persistence flows
  { f: 'claude-code',   t: 'tasks', label: 'claim' },
  { f: 'claude-code',   t: 'leases', bidir: true },
  { f: 'claude-code',   t: 'transcripts' },
  { f: 'transcripts',   t: 'lifecycle', label: 'registry' },
  { f: 'sync-jarry',    t: 'github', bidir: true },
  { f: 'sync-jay',      t: 'github', bidir: true },
  { f: 'sync-jay',      t: 'dashboard', label: 'repo state' },
  // Integrations off the dashboard data plane
  { f: 'dashboard',     t: 'clickup' }, { f: 'dashboard', t: 'ms365' },
  { f: 'dashboard',     t: 'bot', label: 'status' }, { f: 'bot', t: 'kraken', label: 'orders' },
  { f: 'tasks',         t: 'notion', label: 'mirror' },
  { f: 'dashboard',     t: 'discord', label: 'alerts' },
]

const ZONES = [
  { id: 'orchestration', label: 'JARRY · orchestration',     x: 12,  y: 34,  w: 290, h: 164, color: C.cyan, sub: '<<MACHINE_2_TAILSCALE_IP>> · 32GB' },
  { id: 'intelligence',  label: 'JAY · intelligence',         x: 432, y: 34,  w: 300, h: 248, color: C.blue, sub: '<<MACHINE_1_TAILSCALE_IP>> · 64GB · always-on' },
  { id: 'persistence',   label: 'PERSISTENCE',                x: 18,  y: 308, w: 340, h: 110, color: C.emerald, sub: 'git + json state' },
  { id: 'integrations',  label: 'INTEGRATIONS',               x: 450, y: 308, w: 262, h: 104, color: C.amber, sub: 'external services' },
]

function ArchDiagram({ onNodeClick, onZoneClick, jayOnline, ollamaOn }: {
  onNodeClick: (layerId: string, compId: string) => void
  onZoneClick: (layerId: string) => void
  jayOnline: boolean
  ollamaOn: boolean
}) {
  const [hov, setHov] = useState<string | null>(null)
  const byId = Object.fromEntries(GN.map(n => [n.id, n]))
  const cx = (n: GNode) => n.x + n.w / 2
  const cy = (n: GNode) => n.y + n.h / 2

  // Live status per node: jarry-side is this machine (always up); jay-side follows the API.
  const LIVE: Record<string, boolean> = {
    'metis-command': true, 'claude-code': true, 'dispatch': true, 'hooks': true,
    'lifecycle': true, 'sync-jarry': true, 'memory': true,
    'gateway': jayOnline, 'dashboard': jayOnline, 'sync-jay': jayOnline,
    'ollama': ollamaOn, 'forge': ollamaOn, 'scout': ollamaOn, 'shield': ollamaOn,
    'echo': ollamaOn, 'hermes': ollamaOn, 'curator': ollamaOn,
    'bot': jayOnline,
  }

  // Anchor an edge on the border of rect `a`, aimed at rect `b` — so arrowheads
  // land visibly on box edges instead of vanishing underneath them.
  const anchor = (a: GNode, b: GNode): [number, number] => {
    const ax = cx(a), ay = cy(a), dx = cx(b) - ax, dy = cy(b) - ay
    if (dx === 0 && dy === 0) return [ax, ay]
    const tx = dx !== 0 ? (a.w / 2 + 3) / Math.abs(dx) : Infinity
    const ty = dy !== 0 ? (a.h / 2 + 3) / Math.abs(dy) : Infinity
    const t = Math.min(tx, ty)
    return [ax + dx * t, ay + dy * t]
  }

  return (
    <div style={{ width: '100%' }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 6 }}>
        <span style={{ color: C.muted, fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.12em' }}>
          System topology — click any node to drill in
        </span>
        {/* Legend */}
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: C.green, display: 'inline-block' }} />
            <span style={{ color: C.muted, fontSize: 8 }}>live</span>
          </span>
          <span className="flex items-center gap-1">
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: C.amber, display: 'inline-block' }} />
            <span style={{ color: C.muted, fontSize: 8 }}>down</span>
          </span>
        </span>
      </div>
      {/* overflow-x pan keeps node labels legible on narrow (mobile) viewports */}
      <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <svg viewBox="0 0 740 430" width="100%" style={{ display: 'block', minWidth: 640 }}>
        <defs>
          <pattern id="dotgrid" width="18" height="18" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.7" fill="rgba(148,163,184,0.10)" />
          </pattern>
          <filter id="nglow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge>
              <feMergeNode in="b" /><feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <linearGradient id="nodefill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(20,28,46,0.96)" />
            <stop offset="100%" stopColor="rgba(6,10,20,0.96)" />
          </linearGradient>
        </defs>

        {/* Dot-grid backdrop */}
        <rect x="0" y="0" width="740" height="430" fill="url(#dotgrid)" />

        {/* Zone boxes with pill headers */}
        {ZONES.map(z => (
          <g key={z.id}>
            <rect x={z.x} y={z.y} width={z.w} height={z.h} rx="10"
              fill={`${z.color}05`} stroke={`${z.color}28`} strokeWidth="1" />
            {/* corner accents */}
            <path d={`M ${z.x} ${z.y + 14} L ${z.x} ${z.y + 10} Q ${z.x} ${z.y} ${z.x + 10} ${z.y} L ${z.x + 14} ${z.y}`}
              fill="none" stroke={z.color} strokeWidth="1.5" opacity="0.7" />
            <path d={`M ${z.x + z.w - 14} ${z.y + z.h} L ${z.x + z.w - 10} ${z.y + z.h} Q ${z.x + z.w} ${z.y + z.h} ${z.x + z.w} ${z.y + z.h - 10} L ${z.x + z.w} ${z.y + z.h - 14}`}
              fill="none" stroke={z.color} strokeWidth="1.5" opacity="0.7" />
            {/* pill header */}
            <g style={{ cursor: 'pointer' }} onClick={() => onZoneClick(z.id)}>
              <rect x={z.x + 10} y={z.y - 9} width={z.label.length * 5.4 + 26} height={17} rx="8.5"
                fill="rgba(5,8,16,0.95)" stroke={`${z.color}55`} strokeWidth="1" />
              <text x={z.x + 20} y={z.y + 3} fill={z.color} fontSize="8" fontWeight="700"
                fontFamily="SF Mono, Fira Code, monospace" letterSpacing="1.2">
                {z.label.toUpperCase()}
              </text>
              <text x={z.x + 18 + z.label.length * 5.4} y={z.y + 3.5} fill={z.color} fontSize="9" opacity="0.8"
                fontFamily="sans-serif">›</text>
            </g>
            {z.sub && (
              <text x={z.x + z.w - 10} y={z.y + 3} textAnchor="end" fill={`${z.color}70`} fontSize="6.5"
                fontFamily="SF Mono, monospace" letterSpacing="0.5">{z.sub}</text>
            )}
          </g>
        ))}

        {/* Tailscale mesh divider */}
        <line x1="368" y1="60" x2="368" y2="240" stroke="rgba(52,211,255,0.12)" strokeWidth="1" strokeDasharray="2 5" />
        <text x="368" y="150" fill="rgba(52,211,255,0.4)" fontSize="7" textAnchor="middle"
          fontFamily="SF Mono, monospace" transform="rotate(-90 368 150)" letterSpacing="2.5">
          TAILSCALE MESH
        </text>

        {/* Edges: curved, anchored at box borders, manual arrowheads */}
        {GE.map((e, i) => {
          const a = byId[e.f], b = byId[e.t]
          if (!a || !b) return null
          const [x1, y1] = anchor(a, b)
          const [x2, y2] = anchor(b, a)
          const dx = x2 - x1, dy = y2 - y1
          const dist = Math.hypot(dx, dy) || 1
          // gentle perpendicular bow, stronger for long edges
          const bow = Math.min(16, Math.max(5, dist * 0.07))
          const mx = (x1 + x2) / 2 - (dy / dist) * bow
          const my = (y1 + y2) / 2 + (dx / dist) * bow
          const lit = hov === e.f || hov === e.t
          const col = a.color
          // arrowhead direction = end minus control
          const adx = x2 - mx, ady = y2 - my
          const al = Math.hypot(adx, ady) || 1
          const ux = adx / al, uy = ady / al
          const size = 4.5
          const tip = `M ${x2} ${y2} L ${x2 - ux * size * 2 - uy * size} ${y2 - uy * size * 2 + ux * size} L ${x2 - ux * size * 2 + uy * size} ${y2 - uy * size * 2 - ux * size} Z`
          return (
            <g key={i} style={{ transition: 'opacity 0.15s ease' }} opacity={hov && !lit ? 0.25 : 1}>
              <path d={`M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}`} fill="none"
                stroke={lit ? col : `${col}38`}
                strokeWidth={lit ? 1.5 : 1}
                strokeDasharray={lit ? '7 5' : undefined}>
                {lit && <animate attributeName="stroke-dashoffset" values="12;0" dur="0.6s" repeatCount="indefinite" />}
              </path>
              <path d={tip} fill={lit ? col : `${col}55`} />
              {e.bidir && (() => {
                const bdx = x1 - mx, bdy = y1 - my
                const bl = Math.hypot(bdx, bdy) || 1
                const bx = bdx / bl, by = bdy / bl
                return <path d={`M ${x1} ${y1} L ${x1 - bx * size * 2 - by * size} ${y1 - by * size * 2 + bx * size} L ${x1 - bx * size * 2 + by * size} ${y1 - by * size * 2 - bx * size} Z`} fill={lit ? col : `${col}55`} />
              })()}
              {e.label && lit && (
                <g>
                  <rect x={mx - e.label.length * 2.6 - 3} y={my - 8} width={e.label.length * 5.2 + 6} height={11} rx="3"
                    fill="rgba(5,8,16,0.92)" stroke={`${col}40`} strokeWidth="0.5" />
                  <text x={mx} y={my} fill={col} fontSize="6.5" textAnchor="middle"
                    fontFamily="SF Mono, monospace">{e.label}</text>
                </g>
              )}
            </g>
          )
        })}

        {/* Nodes */}
        {GN.map(n => {
          const isHov = hov === n.id
          const live = LIVE[n.id]
          return (
            <g key={n.id}
              style={{ cursor: 'pointer' }}
              opacity={hov && !isHov ? 0.55 : 1}
              filter={isHov ? 'url(#nglow)' : undefined}
              onClick={() => onNodeClick(n.layer, n.comp)}
              onMouseEnter={() => setHov(n.id)}
              onMouseLeave={() => setHov(null)}>
              <rect x={n.x} y={n.y} width={n.w} height={n.h} rx="6"
                fill="url(#nodefill)"
                stroke={isHov ? n.color : `${n.color}50`}
                strokeWidth={isHov ? 1.5 : 1}
                style={{ transition: 'stroke 0.15s ease' }} />
              {/* colored top accent bar */}
              <rect x={n.x + 6} y={n.y} width={n.w - 12} height={1.5} rx="0.75"
                fill={n.color} opacity={isHov ? 0.9 : 0.45} />
              <text x={cx(n)} y={cy(n) + 3} textAnchor="middle"
                fill={isHov ? '#f1f5f9' : n.color} fontSize={n.small ? 8 : 9} fontWeight="600"
                fontFamily="SF Mono, Fira Code, monospace"
                style={{ pointerEvents: 'none', transition: 'fill 0.15s ease' }}>
                {n.label}
              </text>
              {/* live status dot */}
              {live !== undefined && (
                <circle cx={n.x + n.w - 6} cy={n.y + 6} r="2.2"
                  fill={live ? C.green : C.amber}
                  opacity="0.95">
                  {live && <animate attributeName="opacity" values="0.95;0.4;0.95" dur="2.4s" repeatCount="indefinite" />}
                </circle>
              )}
            </g>
          )
        })}
      </svg>
      </div>
    </div>
  )
}

// ── Process map (task lifecycle) ──────────────────────────────────────────────

type PStep = {
  id: string; label: string; x: number; y: number; w: number; h: number; color: string
  desc: string; actions?: { label: string; sublabel: string; href: string }[]
}

const PSTEPS: PStep[] = [
  { id: 'mint',     label: 'mint task',      x: 16,  y: 40,  w: 96,  h: 34, color: C.violet,
    desc: 'Work is born governed: create-task writes what/why/how into tasks.json (gate-at-write). Task IDs are sequential #NNN from the canonical counter — never grepped from the queue.' },
  { id: 'board',    label: 'free-work board', x: 140, y: 40,  w: 110, h: 34, color: C.violet,
    desc: 'free-work.py aggregates tasks.json + leases + OPEN_TASKS.md + GitHub issues into CLAIMED / BLOCKED / FREE / DRIFT / WIP so any session can pick high-value work without colliding.' },
  { id: 'claim',    label: 'claim-next',     x: 278, y: 40,  w: 96,  h: 34, color: C.cyan,
    desc: 'agent-work.py claim-next selects the top free task AND claims it inside one lock — collision-free across simultaneous sessions. Lease carries a Kleppmann fencing token (fenceCounter) against stale writers.' },
  { id: 'work',     label: 'work session',   x: 402, y: 40,  w: 100, h: 34, color: C.cyan,
    desc: 'Claude Code orchestrates: research first (scout), then generation (forge), inline only for git/runtime/1-liners. Session states A→B→C→D managed by the lifecycle daemon.' },
  { id: 'dispatch', label: 'dispatch loop',  x: 530, y: 40,  w: 100, h: 34, color: C.blue,
    desc: 'ROLE × ENGINE routing: pick the cheapest engine that succeeds (qwen-shallow → 5.4m → 5.4 → 5.5-deep → sonnet). High/critical risk requires --approve-risk.' },
  { id: 'curator',  label: 'curator gate',   x: 660, y: 40,  w: 66,  h: 34, color: C.pink,
    desc: 'Automated quality gate: curator reads lane output and returns approve / iterate / reject. is_artifact=false → iterate loop back to the lane. Three-layer task gate: pre-start, pre-dispatch, post-dispatch.' },
  { id: 'verify',   label: 'verify',         x: 530, y: 124, w: 90,  h: 34, color: C.emerald,
    desc: 'Verification gate before any "done": exercise the changed code path, check response bodies not just exit codes, capture evidence. Runtime surface reachable → MUST be exercised.' },
  { id: 'commit',   label: 'commit + push',  x: 402, y: 124, w: 100, h: 34, color: C.emerald,
    desc: 'git-lock.sh serialises commits. Explicit pathspecs only (never bare -m or add -A). Push rejected → leave local, auto-sync daemon merges. Commit message body IS the session record.' },
  { id: 'checkpoint', label: 'checkpoint',   x: 278, y: 124, w: 96,  h: 34, color: C.amber,
    desc: '/checkpoint banks the task: working-context ops under lock, descriptive commit, SHA marker. /end adds reflection, daily log, task dedup, memory sweep, rename.' },
  { id: 'done',     label: 'done · unclaim', x: 140, y: 124, w: 110, h: 34, color: C.green,
    desc: 'Reconcile 3 done-signals: tasks.json state, lease status (unclaim), artifact verified empirically. Lease wins over lagging task state — never release a fresh lease on a non-terminal task.' },
]

const PEDGES: { f: string; t: string; label?: string; back?: boolean }[] = [
  { f: 'mint', t: 'board' }, { f: 'board', t: 'claim' }, { f: 'claim', t: 'work' },
  { f: 'work', t: 'dispatch' }, { f: 'dispatch', t: 'curator' },
  { f: 'curator', t: 'dispatch', label: 'iterate', back: true },
  { f: 'curator', t: 'verify' }, { f: 'verify', t: 'commit' },
  { f: 'commit', t: 'checkpoint' }, { f: 'checkpoint', t: 'done' },
  { f: 'checkpoint', t: 'board', label: 'next task', back: true },
  { f: 'verify', t: 'work', label: 'fail', back: true },
]

function ProcessMap({ onStepClick }: { onStepClick: (id: string) => void }) {
  const [hov, setHov] = useState<string | null>(null)
  const byId = Object.fromEntries(PSTEPS.map(s => [s.id, s]))
  const cx = (s: PStep) => s.x + s.w / 2
  const cy = (s: PStep) => s.y + s.h / 2

  // Same border-anchored edges as the architecture diagram, for visual consistency.
  const anchor = (a: PStep, b: PStep): [number, number] => {
    const ax = cx(a), ay = cy(a), dx = cx(b) - ax, dy = cy(b) - ay
    if (dx === 0 && dy === 0) return [ax, ay]
    const tx = dx !== 0 ? (a.w / 2 + 3) / Math.abs(dx) : Infinity
    const ty = dy !== 0 ? (a.h / 2 + 3) / Math.abs(dy) : Infinity
    const t = Math.min(tx, ty)
    return [ax + dx * t, ay + dy * t]
  }

  return (
    <div style={{ width: '100%' }}>
      <div style={{ color: C.muted, fontSize: 9, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.12em' }}>
        Task lifecycle — click any step
      </div>
      <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <svg viewBox="0 0 740 200" width="100%" style={{ display: 'block', minWidth: 560 }}>
        <defs>
          <pattern id="pdotgrid" width="18" height="18" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.7" fill="rgba(148,163,184,0.10)" />
          </pattern>
          <filter id="pglow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <linearGradient id="pnodefill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(20,28,46,0.96)" />
            <stop offset="100%" stopColor="rgba(6,10,20,0.96)" />
          </linearGradient>
        </defs>

        <rect x="0" y="0" width="740" height="200" fill="url(#pdotgrid)" />

        {PEDGES.map((e, i) => {
          const a = byId[e.f], b = byId[e.t]
          const lit = hov === e.f || hov === e.t
          const col = a.color
          const [x1, y1] = e.back ? [cx(a), a.y] : anchor(a, b)
          const [x2, y2] = e.back ? [cx(b), b.y] : anchor(b, a)
          // back edges arc above the row; forward edges bow gently
          let mx: number, my: number
          if (e.back) {
            mx = (x1 + x2) / 2
            my = Math.min(y1, y2) - 30
          } else {
            const dx = x2 - x1, dy = y2 - y1
            const dist = Math.hypot(dx, dy) || 1
            const bow = Math.min(12, Math.max(4, dist * 0.06))
            mx = (x1 + x2) / 2 - (dy / dist) * bow
            my = (y1 + y2) / 2 + (dx / dist) * bow
          }
          const adx = x2 - mx, ady = y2 - my
          const al = Math.hypot(adx, ady) || 1
          const ux = adx / al, uy = ady / al
          const size = 4.5
          const tip = `M ${x2} ${y2} L ${x2 - ux * size * 2 - uy * size} ${y2 - uy * size * 2 + ux * size} L ${x2 - ux * size * 2 + uy * size} ${y2 - uy * size * 2 - ux * size} Z`
          return (
            <g key={i} opacity={hov && !lit ? 0.25 : 1} style={{ transition: 'opacity 0.15s ease' }}>
              <path d={`M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}`} fill="none"
                stroke={lit ? col : `${col}38`}
                strokeWidth={lit ? 1.5 : 1}
                strokeDasharray={lit ? '7 5' : (e.back ? '4 3' : undefined)}>
                {lit && <animate attributeName="stroke-dashoffset" values="12;0" dur="0.6s" repeatCount="indefinite" />}
              </path>
              <path d={tip} fill={lit ? col : `${col}55`} />
              {e.label && (
                <g>
                  <rect x={mx - e.label.length * 2.6 - 3} y={my - 4} width={e.label.length * 5.2 + 6} height={11} rx="3"
                    fill="rgba(5,8,16,0.92)" stroke={`${col}40`} strokeWidth="0.5" />
                  <text x={mx} y={my + 4} fill={lit ? col : `${col}90`} fontSize="6.5" textAnchor="middle"
                    fontFamily="SF Mono, monospace">{e.label}</text>
                </g>
              )}
            </g>
          )
        })}

        {PSTEPS.map(s => {
          const isHov = hov === s.id
          return (
            <g key={s.id} style={{ cursor: 'pointer' }}
              opacity={hov && !isHov ? 0.55 : 1}
              filter={isHov ? 'url(#pglow)' : undefined}
              onClick={() => onStepClick(s.id)}
              onMouseEnter={() => setHov(s.id)}
              onMouseLeave={() => setHov(null)}>
              <rect x={s.x} y={s.y} width={s.w} height={s.h} rx="6"
                fill="url(#pnodefill)"
                stroke={isHov ? s.color : `${s.color}50`}
                strokeWidth={isHov ? 1.4 : 1}
                style={{ transition: 'stroke 0.15s ease' }} />
              <rect x={s.x + 6} y={s.y} width={s.w - 12} height={1.5} rx="0.75"
                fill={s.color} opacity={isHov ? 0.9 : 0.45} />
              <text x={cx(s)} y={cy(s) + 3} textAnchor="middle"
                fill={isHov ? '#f1f5f9' : s.color} fontSize="8.5" fontWeight="600"
                fontFamily="SF Mono, Fira Code, monospace"
                style={{ pointerEvents: 'none', transition: 'fill 0.15s ease' }}>{s.label}</text>
            </g>
          )
        })}
      </svg>
      </div>
    </div>
  )
}

function ProcessStepView({ step }: { step: PStep }) {
  return (
    <div className="flex flex-col gap-3">
      <div style={{ background: `${step.color}12`, border: `1px solid ${step.color}35`, borderRadius: 8, padding: '12px 14px' }}>
        <div style={{ color: step.color, fontFamily: 'SF Mono, monospace', fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
          {step.label}
        </div>
        <div style={{ color: C.textDim, fontSize: 10, lineHeight: 1.7 }}>{step.desc}</div>
      </div>
      <div>
        <div style={{ color: C.muted, fontSize: 9, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.12em' }}>Actions</div>
        <div className="flex flex-col gap-1.5">
          {step.id === 'mint' && <ActionLink label="Task naming convention" sublabel="docs/process/task-naming-convention.md" href="metis://open?path=docs/process/task-naming-convention.md" color={step.color} />}
          {(step.id === 'board' || step.id === 'claim' || step.id === 'done') && <ActionLink label="Open task board" sublabel="Jay/state/OPEN_TASKS.md" href="metis://open?path=Jay/state/OPEN_TASKS.md" color={step.color} />}
          {step.id === 'dispatch' && <ActionLink label="Lane reference" sublabel="docs/process/jay-lanes.md" href="metis://open?path=docs/process/jay-lanes.md" color={step.color} />}
          {(step.id === 'checkpoint' || step.id === 'commit') && <ActionLink label="Session output standard" sublabel="docs/process/session-output-standard.md" href="metis://open?path=docs/process/session-output-standard.md" color={step.color} />}
          {step.id === 'work' && <ActionLink label="Task lifecycle standard" sublabel="docs/process/task-pickup-and-lifecycle-standard.md" href="metis://open?path=docs/process/task-pickup-and-lifecycle-standard.md" color={step.color} />}
        </div>
      </div>
    </div>
  )
}

// ── Per-tab roots ─────────────────────────────────────────────────────────────

// ── Efforts treemap ───────────────────────────────────────────────────────────
// Weight-proportional tiles, one per goal; same visual language as the maps.
// Binary-split treemap: recursively halve the weight mass along the long axis.

type TmRect = { g: MetisGoal; x: number; y: number; w: number; h: number }

function tmLayout(items: MetisGoal[], x: number, y: number, w: number, h: number, out: TmRect[]): void {
  if (items.length === 0) return
  if (items.length === 1) { out.push({ g: items[0], x, y, w, h }); return }
  const wt = (g: MetisGoal) => Math.max(g.weight || 1, 0.0001)
  const total = items.reduce((s, g) => s + wt(g), 0)
  // prefix-split closest to half the mass
  let acc = 0, cut = 1
  for (let i = 0; i < items.length - 1; i++) {
    acc += wt(items[i])
    if (acc >= total / 2) { cut = i + 1; break }
    cut = i + 1
  }
  const a = items.slice(0, cut), b = items.slice(cut)
  const fa = a.reduce((s, g) => s + wt(g), 0) / total
  if (w >= h) {
    tmLayout(a, x, y, w * fa, h, out)
    tmLayout(b, x + w * fa, y, w * (1 - fa), h, out)
  } else {
    tmLayout(a, x, y, w, h * fa, out)
    tmLayout(b, x, y + h * fa, w, h * (1 - fa), out)
  }
}

function EffortsTreemap({ goals, onGoalClick }: { goals: MetisGoal[]; onGoalClick: (id: string) => void }) {
  const [hov, setHov] = useState<string | null>(null)
  const W = 740, H = 200, PAD = 2
  const sorted = [...goals].sort((a, b) => (b.weight || 1) - (a.weight || 1))
  const rects: TmRect[] = []
  tmLayout(sorted, 0, 0, W, H, rects)

  return (
    <div style={{ width: '100%' }}>
      <div style={{ color: C.muted, fontSize: 9, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.12em' }}>
        Goals by weight — tile area = priority · fill = completion
      </div>
      <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block', minWidth: 480 }}>
        <defs>
          <filter id="tmglow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="2.5" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        {rects.map(({ g, x, y, w, h }) => {
          const pct = goalPct(g)
          const col = goalBarColor(g)
          const isHov = hov === g.id
          const ix = x + PAD, iy = y + PAD, iw = Math.max(w - PAD * 2, 1), ih = Math.max(h - PAD * 2, 1)
          const fillH = (ih * pct) / 100
          const showLabel = iw > 86 && ih > 40
          const showPct = iw > 40 && ih > 26
          return (
            <g key={g.id} style={{ cursor: 'pointer' }}
              opacity={hov && !isHov ? 0.55 : 1}
              filter={isHov ? 'url(#tmglow)' : undefined}
              onClick={() => onGoalClick(g.id)}
              onMouseEnter={() => setHov(g.id)}
              onMouseLeave={() => setHov(null)}>
              <title>{`${g.title} — ${pct}% · ${g.active + g.in_progress} active · ${g.blocked} blocked · weight ${g.weight}`}</title>
              {/* tile base */}
              <rect x={ix} y={iy} width={iw} height={ih} rx="5"
                fill="rgba(8,13,24,0.92)"
                stroke={isHov ? col : `${col}45`}
                strokeWidth={isHov ? 1.4 : 1}
                style={{ transition: 'stroke 0.15s ease' }} />
              {/* completion fill rises from the bottom */}
              <rect x={ix} y={iy + ih - fillH} width={iw} height={fillH} rx="5"
                fill={`${col}1c`} style={{ transition: 'all 0.4s ease' }} />
              {/* top accent */}
              <rect x={ix + 5} y={iy} width={Math.max(iw - 10, 2)} height={1.5} rx="0.75"
                fill={col} opacity={isHov ? 0.9 : 0.45} />
              {showLabel && (
                <text x={ix + 8} y={iy + 16} fill={isHov ? '#f1f5f9' : C.text} fontSize="9" fontWeight="600"
                  fontFamily="SF Mono, Fira Code, monospace" style={{ pointerEvents: 'none' }}>
                  {g.title.length > iw / 6 ? g.title.slice(0, Math.floor(iw / 6)) + '…' : g.title}
                </text>
              )}
              {showPct && (
                <text x={ix + iw - 8} y={iy + ih - 8} textAnchor="end" fill={col} fontSize="10" fontWeight="700"
                  fontFamily="SF Mono, monospace" style={{ pointerEvents: 'none' }}>
                  {pct}%
                </text>
              )}
              {g.blocked > 0 && (
                <circle cx={ix + iw - 7} cy={iy + 7} r="2.2" fill={C.amber} opacity="0.95">
                  <animate attributeName="opacity" values="0.95;0.4;0.95" dur="2s" repeatCount="indefinite" />
                </circle>
              )}
            </g>
          )
        })}
      </svg>
      </div>
    </div>
  )
}

function EffortsRoot({
  goals,
  onGoalClick,
}: {
  goals: MetisGoal[]
  onGoalClick: (id: string) => void
}) {
  const totalTasks = goals.reduce((s, g) => s + g.active + g.in_progress + g.blocked + g.done, 0)
  const doneTasks = goals.reduce((s, g) => s + g.done, 0)
  const overallPct = totalTasks === 0 ? 0 : Math.round((doneTasks / totalTasks) * 100)
  const blocked = goals.filter(g => g.blocked > 0)

  if (goals.length === 0) {
    return <div style={{ color: C.muted, fontSize: 10, padding: '12px 0' }}>No goals data — backend offline</div>
  }

  return (
    <div className="flex flex-col gap-3">
      <EffortsTreemap goals={goals} onGoalClick={onGoalClick} />
      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 7, padding: '8px 12px' }}>
        <div className="flex items-center justify-between mb-2">
          <span style={{ color: C.textDim, fontSize: 10 }}>{goals.length} goals · {totalTasks} tasks</span>
          <span style={{ color: C.cyan, fontFamily: 'SF Mono, monospace', fontSize: 12, fontWeight: 700 }}>{overallPct}%</span>
        </div>
        <div style={{ height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.06)' }}>
          <div style={{ height: '100%', width: `${overallPct}%`, borderRadius: 2, background: `linear-gradient(90deg, ${C.cyan}, ${C.violet})`, transition: 'width 0.6s ease' }} />
        </div>
        {blocked.length > 0 && (
          <div style={{ color: C.amber, fontSize: 9, marginTop: 5 }}>⚠ {blocked.length} goal{blocked.length > 1 ? 's' : ''} blocked</div>
        )}
      </div>
      {goals.map(g => (
        <DrillCard
          key={g.id}
          label={g.title}
          sublabel={`${goalPct(g)}% · ${g.active + g.in_progress} active · ${g.blocked} blocked`}
          color={goalBarColor(g)}
          accent={g.blocked > 0}
          onClick={() => onGoalClick(g.id)}
          right={g.blocked > 0 ? <Pill label="blocked" color={C.amber} /> : undefined}
        />
      ))}
    </div>
  )
}

function LayerView({
  layer,
  onComponentClick,
}: {
  layer: LayerDef
  onComponentClick: (id: string) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <div style={{ background: layer.dim, border: `1px solid ${layer.border}`, borderRadius: 7, padding: '10px 12px', marginBottom: 4 }}>
        <div style={{ color: layer.color, fontFamily: 'SF Mono, monospace', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>
          {layer.label}
        </div>
        <div style={{ color: C.textDim, fontSize: 10, lineHeight: 1.6 }}>{layer.detail}</div>
      </div>
      {layer.components.map(c => (
        <DrillCard
          key={c.id}
          label={c.label}
          sublabel={c.desc.slice(0, 80) + (c.desc.length > 80 ? '…' : '')}
          color={layer.color}
          onClick={() => onComponentClick(c.id)}
        />
      ))}
    </div>
  )
}

function ComponentView({
  layer,
  component,
  jayOnline,
  ollamaOnline,
  modelName,
}: {
  layer: LayerDef
  component: ComponentDef
  jayOnline: boolean
  ollamaOnline: boolean
  modelName: string
}) {
  const laneColor = LANE_COLORS[component.id] ?? layer.color

  const liveStatus = (() => {
    if (component.id === 'gateway') return { ok: jayOnline, label: jayOnline ? 'online · :18789' : 'unreachable' }
    if (component.id === 'ollama') return { ok: ollamaOnline, label: ollamaOnline ? `online · ${modelName || 'model loaded'}` : 'not running' }
    if (['forge','scout','shield','echo','hermes','curator'].includes(component.id)) {
      return { ok: ollamaOnline, label: ollamaOnline ? 'ready' : 'offline (Ollama down)' }
    }
    return null
  })()

  return (
    <div className="flex flex-col gap-3">
      <div style={{ background: `${laneColor}12`, border: `1px solid ${laneColor}35`, borderRadius: 8, padding: '12px 14px' }}>
        <div style={{ color: laneColor, fontFamily: 'SF Mono, monospace', fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
          {component.label}
        </div>
        <div style={{ color: C.textDim, fontSize: 10, lineHeight: 1.7 }}>{component.desc}</div>
        {liveStatus && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: liveStatus.ok ? C.green : C.amber, display: 'inline-block', boxShadow: liveStatus.ok ? `0 0 5px ${C.green}` : 'none' }} />
            <span style={{ color: liveStatus.ok ? C.green : C.amber, fontSize: 9, fontFamily: 'SF Mono, monospace' }}>{liveStatus.label}</span>
          </div>
        )}
      </div>

      {/* Contextual action links */}
      <div>
        <div style={{ color: C.muted, fontSize: 9, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.12em' }}>Actions</div>
        <div className="flex flex-col gap-1.5">
          {component.id === 'task-system' && (
            <ActionLink label="View task board" sublabel="Jay/state/OPEN_TASKS.md" href="metis://open?path=Jay/state/OPEN_TASKS.md" color={C.cyan} />
          )}
          {component.id === 'dispatch' && (
            <ActionLink label="View dispatch config" sublabel="~/.openclaw/openclaw.json" href="metis://open?path=.openclaw/openclaw.json" color={C.cyan} />
          )}
          {component.id === 'session-lifecycle' && (
            <ActionLink label="Session lifecycle daemon" sublabel="scripts/session-lifecycle.py" href="metis://open?path=scripts/session-lifecycle.py" color={C.cyan} />
          )}
          {component.id === 'github' && (
            <ActionLink label="metis-os on GitHub" sublabel="github.com/…" href="https://github.com" color={C.violet} />
          )}
          {component.id === 'clickup' && (
            <ActionLink label="Open ClickUp" sublabel="Navore Market workspace" href="https://app.clickup.com" color={C.amber} />
          )}
          {component.id === 'notion' && (
            <ActionLink label="Open Notion" sublabel="Command Center DB" href="https://notion.so" color={C.textDim} />
          )}
          <ActionLink
            label="Open in terminal"
            sublabel={`dispatch --agent ${component.id} --message "status"`}
            href={`metis://dispatch?agent=${component.id}`}
            color={C.muted}
          />
        </div>
      </div>
    </div>
  )
}

function ActionLink({ label, sublabel, href, color }: { label: string; sublabel: string; href: string; color: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: C.bg,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: '7px 10px',
        textDecoration: 'none',
        transition: 'all 0.15s ease',
        cursor: 'pointer',
      }}
    >
      <span style={{ color, fontSize: 11 }}>↗</span>
      <span style={{ flex: 1 }}>
        <span style={{ display: 'block', color: C.text, fontSize: 10, fontWeight: 600 }}>{label}</span>
        <span style={{ display: 'block', color: C.muted, fontSize: 9, fontFamily: 'SF Mono, monospace' }}>{sublabel}</span>
      </span>
    </a>
  )
}

// Same visual language as ActionLink but routes inside the app (onClick) rather
// than firing a metis:// / external href. Used to deep-link a goal into the Tasks board.
function NavActionButton({ label, sublabel, onClick, color }: { label: string; sublabel: string; onClick: () => void; color: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        background: C.bg,
        border: `1px solid ${color}35`,
        borderRadius: 6,
        padding: '7px 10px',
        textAlign: 'left',
        transition: 'all 0.15s ease',
        cursor: 'pointer',
      }}
    >
      <span style={{ color, fontSize: 11 }}>→</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', color: C.text, fontSize: 10, fontWeight: 600 }}>{label}</span>
        <span style={{ display: 'block', color: C.muted, fontSize: 9, fontFamily: 'SF Mono, monospace' }}>{sublabel}</span>
      </span>
      <span style={{ color: C.muted, fontSize: 12, flexShrink: 0 }}>›</span>
    </button>
  )
}

function GoalDetailView({
  goal,
  onDrillTasks,
  onGoToTasks,
}: {
  goal: MetisGoal
  onDrillTasks: () => void
  onGoToTasks: () => void
}) {
  const pct = goalPct(goal)
  const barColor = goalBarColor(goal)
  const total = goal.active + goal.in_progress + goal.blocked + goal.done

  return (
    <div className="flex flex-col gap-3">
      <div style={{ background: `${barColor}10`, border: `1px solid ${barColor}35`, borderRadius: 8, padding: '12px 14px' }}>
        <div style={{ color: C.text, fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{goal.title}</div>
        <div style={{ color: C.muted, fontSize: 9, marginBottom: 10, fontFamily: 'SF Mono, monospace' }}>system #{goal.system} · weight {goal.weight}</div>

        {/* Progress bar */}
        <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.06)', marginBottom: 4 }}>
          <div style={{ height: '100%', width: `${pct}%`, borderRadius: 3, background: barColor, transition: 'width 0.4s ease' }} />
        </div>
        <div style={{ color: barColor, fontFamily: 'SF Mono, monospace', fontSize: 11, fontWeight: 700, marginBottom: 12 }}>{pct}% complete</div>

        {/* Task counts */}
        <div className="grid grid-cols-2 gap-2">
          {[
            { label: 'Active',      count: goal.active,      color: C.cyan },
            { label: 'In Progress', count: goal.in_progress, color: C.blue },
            { label: 'Blocked',     count: goal.blocked,     color: C.amber },
            { label: 'Done',        count: goal.done,        color: C.green },
          ].map(({ label, count, color }) => (
            <div key={label} style={{ background: count > 0 ? `${color}10` : 'rgba(255,255,255,0.02)', border: `1px solid ${count > 0 ? color + '30' : C.border}`, borderRadius: 5, padding: '6px 10px' }}>
              <div style={{ color: count > 0 ? color : C.muted, fontFamily: 'SF Mono, monospace', fontSize: 16, fontWeight: 700 }}>{count}</div>
              <div style={{ color: C.muted, fontSize: 9 }}>{label}</div>
            </div>
          ))}
        </div>
        <div style={{ color: C.muted, fontSize: 9, marginTop: 8 }}>{total} total tasks</div>
      </div>

      {/* Drill into task breakdown */}
      {total > 0 && (
        <DrillCard
          label="View task breakdown"
          sublabel={`${goal.active + goal.in_progress} active · ${goal.blocked} blocked · ${goal.done} done`}
          color={barColor}
          onClick={onDrillTasks}
        />
      )}

      {/* Actions */}
      <div>
        <div style={{ color: C.muted, fontSize: 9, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.12em' }}>Actions</div>
        <div className="flex flex-col gap-1.5">
          <NavActionButton label="Open this goal in Tasks" sublabel={`${goal.title} · ${total} task${total === 1 ? '' : 's'}`} onClick={onGoToTasks} color={barColor} />
          {goal.blocked > 0 && (
            <ActionLink label="Resolve blockers" sublabel={`${goal.blocked} blocked task${goal.blocked > 1 ? 's' : ''} need attention`} href="metis://open?path=Jay/state/OPEN_TASKS.md" color={C.amber} />
          )}
        </div>
      </div>
    </div>
  )
}

function AllGoalsView({ goals, onGoalClick }: { goals: MetisGoal[]; onGoalClick: (id: string) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div style={{ color: C.muted, fontSize: 9, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.12em' }}>All goals</div>
      {goals.map(g => (
        <DrillCard
          key={g.id}
          label={g.title}
          sublabel={`${goalPct(g)}% · ${g.active + g.in_progress} active · ${g.blocked} blocked`}
          color={goalBarColor(g)}
          accent={g.blocked > 0}
          onClick={() => onGoalClick(g.id)}
          right={g.blocked > 0 ? <Pill label="blocked" color={C.amber} /> : undefined}
        />
      ))}
    </div>
  )
}

function TaskBreakdownView({ goal, onGoToTasks }: { goal: MetisGoal; onGoToTasks: () => void }) {
  const rows = [
    { label: 'Active tasks',      count: goal.active,      color: C.cyan,   desc: 'Claimed and currently being worked on' },
    { label: 'In progress',       count: goal.in_progress, color: C.blue,   desc: 'Started but not yet at a review/done gate' },
    { label: 'Blocked tasks',     count: goal.blocked,     color: C.amber,  desc: 'Waiting on external input or dependency' },
    { label: 'Completed tasks',   count: goal.done,        color: C.green,  desc: 'Done and verified' },
  ]
  return (
    <div className="flex flex-col gap-2">
      <div style={{ color: C.textDim, fontSize: 10, marginBottom: 4 }}>Task breakdown for <strong style={{ color: C.text }}>{goal.title}</strong></div>
      {rows.filter(r => r.count > 0).map(r => (
        <div key={r.label} style={{ background: `${r.color}0d`, border: `1px solid ${r.color}30`, borderRadius: 7, padding: '10px 12px' }}>
          <div className="flex items-center gap-2 mb-1">
            <span style={{ color: r.color, fontFamily: 'SF Mono, monospace', fontSize: 18, fontWeight: 700 }}>{r.count}</span>
            <span style={{ color: r.color, fontSize: 11, fontWeight: 600 }}>{r.label}</span>
          </div>
          <div style={{ color: C.textDim, fontSize: 10 }}>{r.desc}</div>
        </div>
      ))}
      {rows.every(r => r.count === 0) ? (
        <div style={{ color: C.muted, fontSize: 10 }}>No tasks for this goal yet.</div>
      ) : (
        <NavActionButton label="Open this goal in Tasks" sublabel={`${goal.title} — filtered task board`} onClick={onGoToTasks} color={goalBarColor(goal)} />
      )}
    </div>
  )
}

// ── Breadcrumb ────────────────────────────────────────────────────────────────
function Breadcrumb({ stack, onPop }: { stack: Frame[]; onPop: () => void }) {
  if (stack.length <= 1) return null
  const current = stack[stack.length - 1]
  const parent = stack[stack.length - 2]

  const parentLabel = (() => {
    if (parent.kind === 'root') return 'Overview'
    if (parent.kind === 'layer') return LAYERS.find(l => l.id === parent.layerId)?.label ?? parent.layerId
    if (parent.kind === 'goal') {
      return 'Goal'
    }
    return 'Back'
  })()

  const _ = current // satisfy lint
  void _

  return <BackButton label={parentLabel} onClick={onPop} />
}

// ── Root component ────────────────────────────────────────────────────────────

type SubTab = 'architecture' | 'process' | 'efforts'

export default function SystemMapPanel() {
  const { data } = useMetisAll()
  const nav = useControlCenterNav()
  const [tab, setTab] = useState<SubTab>('architecture')
  const [stacks, setStacks] = useState<Record<SubTab, Frame[]>>({
    architecture: [{ kind: 'root' }],
    process: [{ kind: 'root' }],
    efforts: [{ kind: 'root' }],
  })

  const jayOnline = data?.jay?.gateway_running ?? false
  const ollamaOn  = data?.ollama?.running ?? false
  const modelName = data?.ollama?.models?.[0]?.name ?? ''
  const goals     = data?.priorities?.goals ?? []

  const stack = stacks[tab]
  const push = (frame: Frame) => setStacks(s => ({ ...s, [tab]: [...s[tab], frame] }))
  const pop  = () => setStacks(s => ({ ...s, [tab]: s[tab].length > 1 ? s[tab].slice(0, -1) : s[tab] }))

  const current = stack[stack.length - 1]

  const renderView = () => {
    if (current.kind === 'root') {
      if (tab === 'architecture') {
        return (
          <ArchDiagram
            onNodeClick={(layerId, compId) => push({ kind: 'component', layerId, componentId: compId })}
            onZoneClick={(id) => push({ kind: 'layer', layerId: id })}
            jayOnline={jayOnline}
            ollamaOn={ollamaOn}
          />
        )
      }
      if (tab === 'process') {
        return <ProcessMap onStepClick={(id) => push({ kind: 'process-step', stepId: id })} />
      }
      return <EffortsRoot goals={goals} onGoalClick={(id) => push({ kind: 'goal', goalId: id })} />
    }

    if (current.kind === 'layer') {
      const layer = LAYERS.find(l => l.id === current.layerId)
      if (!layer) return null
      return (
        <LayerView
          layer={layer}
          onComponentClick={(cid) => push({ kind: 'component', layerId: current.layerId, componentId: cid })}
        />
      )
    }

    if (current.kind === 'component') {
      const layer = LAYERS.find(l => l.id === current.layerId)
      const component = layer?.components.find(c => c.id === current.componentId)
      if (!layer || !component) return null
      return (
        <ComponentView
          layer={layer}
          component={component}
          jayOnline={jayOnline}
          ollamaOnline={ollamaOn}
          modelName={modelName}
        />
      )
    }

    if (current.kind === 'process-step') {
      const step = PSTEPS.find(s => s.id === current.stepId)
      if (!step) return null
      return <ProcessStepView step={step} />
    }

    if (current.kind === 'goal') {
      const goal = goals.find(g => g.id === current.goalId)
      if (!goal) return <div style={{ color: C.muted, fontSize: 10 }}>Goal not found</div>
      return (
        <GoalDetailView
          goal={goal}
          onDrillTasks={() => push({ kind: 'task-breakdown', goalId: goal.id })}
          onGoToTasks={() => nav.goto('tasks', { goalId: goal.id, goalLabel: `${goal.id} · ${goal.title}` })}
        />
      )
    }

    if (current.kind === 'task-breakdown') {
      const goal = goals.find(g => g.id === current.goalId)
      if (!goal) return null
      return (
        <TaskBreakdownView
          goal={goal}
          onGoToTasks={() => nav.goto('tasks', { goalId: goal.id, goalLabel: `${goal.id} · ${goal.title}` })}
        />
      )
    }

    return null
  }

  return (
    <div className="p-3">
      {/* Sub-tab bar */}
      <div className="flex gap-1 mb-3">
        {([['architecture', 'Architecture'], ['process', 'Process'], ['efforts', 'Active Efforts']] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            style={{
              background: tab === id ? 'rgba(52,211,255,0.08)' : 'transparent',
              border: tab === id ? `1px solid ${C.cyanBorder}` : '1px solid transparent',
              color: tab === id ? C.cyan : C.textDim,
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
            className="rounded px-3 py-1 text-[10px] uppercase tracking-widest font-semibold"
          >
            {label}
          </button>
        ))}
      </div>
      <Breadcrumb stack={stack} onPop={pop} />
      {renderView()}
    </div>
  )
}
