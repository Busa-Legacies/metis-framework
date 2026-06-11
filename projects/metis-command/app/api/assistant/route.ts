import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ptyApi } from '@/lib/pty-client'
import type { AgentKind, Attachment } from '@/lib/types'
import { effectiveModel, effectiveOpenAIKey, normalizeAssistantPersona, readSettings, type NormalizedAssistantPersona } from '@/lib/settings'
import { runCliBrain, type CliProvider } from '@/lib/cli-brain'
import { runOpenClawGatewayChat } from '@/lib/openclaw-gateway'
import { runOpenClawMetisBrainTurn } from '@/lib/openclaw-runtime'
import { getAuthStatus } from '@/lib/auth-status'
import { METIS_BRAIN_WORKBENCH_PREAMBLE, loadMetisBrainIdentity } from '@/lib/metis-brain-persona'
import { resolveDirectAgentTarget, validateToolCall } from '@/lib/tool-routing'
import { resolveWorkspaceSelector } from '@/lib/workspace-selector'
import { prepareCurrentTurnActions, type TurnActionLedgerEntry } from '@/lib/action-ledger'
import { buildWorkbenchSessionKey, type WorkbenchGatewayMetadata } from '@/lib/workbench-session'
import {
  beginDispatchAction,
  completeDispatchAction,
  dispatchRunStatus,
  dispatchRunStatusForSession,
  synthesizeDispatchRunId,
} from '@/lib/dispatch-runs'
import { buildControlCenterSummary } from '@/lib/control-center-summary'
import { summarizePortfolio } from '@/lib/summarize-portfolio'
import {
  acknowledgeControlCenterAgent,
  detectControlCenterReports,
  readControlCenterAcks,
  readControlCenterReports,
} from '@/lib/control-center-continuity'
import { evidenceCounts } from '@/lib/evidence-ledger'

const IMAGE_DIR = path.join(os.homedir(), '.openclaw', 'metis-command', 'images')

/**
 * Append a carriage return so the CLI agent actually executes the dispatched text.
 * If the caller explicitly passes submit=false (or the text already ends with a newline/CR),
 * we leave it alone.
 */
function autoSubmitText(text: unknown, submitFlag: unknown): string {
  const s = typeof text === 'string' ? text : ''
  if (submitFlag === false) return s
  if (!s) return s
  if (s.endsWith('\r') || s.endsWith('\n')) return s
  return s + '\r'
}

function persistImageAttachments(atts: Attachment[]): { path: string; name: string }[] {
  fs.mkdirSync(IMAGE_DIR, { recursive: true })
  const out: { path: string; name: string }[] = []
  for (const a of atts) {
    if (a.type !== 'image') continue
    const m = a.dataUrl.match(/^data:image\/([a-zA-Z0-9+.\-]+);base64,(.+)$/)
    if (!m) continue
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1].replace(/\+.*/, '')
    const buf = Buffer.from(m[2], 'base64')
    const fname = `aw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`
    const filePath = path.join(IMAGE_DIR, fname)
    fs.writeFileSync(filePath, buf)
    out.push({ path: filePath, name: a.name })
  }
  return out
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ---------- shared tool schema ----------

const toolDescriptions = `Available tools (call by emitting an action block — see format below):
- spawn_agents({ specs: [{ kind: "claude"|"codex"|"shell"|"gemini"|"python", name: string, initial_prompt?: string }], workspace_id?: string }) — initial_prompt delivers the full task brief at spawn; for build/fix dispatches ALWAYS use it instead of a follow-up send_to_agent
- kill_agent({ id: string, workspace_id?: string })
- rename_agent({ id: string, name: string, workspace_id?: string })
- send_to_agent({ id: string, text: string, workspace_id?: string })   // append \\n to submit
- broadcast({ text: string, kind?: "claude"|"codex"|"shell", workspace_id?: string })   // send same text to all running agents (optionally filter by kind)
- read_agent_output({ id: string, lines?: number, workspace_id?: string })   // last N lines of an agent's terminal output (default 200)
- list_agents()
- list_workspaces()
- create_workspace({ name: string, cwd?: string })
- get_dispatch_status({ workspace_id?: string, run_id?: string })
- get_control_center_summary({ workspace_ids?: string[], runs_limit?: number, stale_threshold_ms?: number, reports_limit?: number, include_acked?: boolean })
- acknowledge_agent({ agent_id: string, workspace_id?: string, reason?: string, by?: string })   // marks an exited pane as reviewed; does not delete it
- list_workspace_reports({ workspace_id: string, reports_limit?: number, unread_only?: boolean })
- summarize_portfolio({ workspaceFilter?: string, actionableOnly?: boolean })   // Telegram-safe portfolio rollup across workspaces; one line per workspace, sorted actionable-first`

const openAITools: OpenAI.Chat.ChatCompletionTool[] = [
  { type: 'function', function: { name: 'spawn_agents', description: 'Spawn one or more CLI agents.', parameters: { type: 'object', properties: { workspace_id: { type: 'string' }, specs: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: ['claude','codex','shell','gemini','python','custom'] }, name: { type: 'string' }, cmd: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, initial_prompt: { type: 'string', description: 'Full task brief delivered to the agent at spawn — for codex/claude builders this makes dispatch a single call (no follow-up send_to_agent needed).' } }, required: ['kind','name'] } } }, required: ['specs'] } } },
  { type: 'function', function: { name: 'kill_agent', description: 'Kill agent by id. Cross-workspace ids require matching workspace_id.', parameters: { type: 'object', properties: { id: { type: 'string' }, workspace_id: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'rename_agent', description: 'Rename agent tab. Cross-workspace ids require matching workspace_id.', parameters: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, workspace_id: { type: 'string' } }, required: ['id','name'] } } },
  { type: 'function', function: { name: 'send_to_agent', description: 'Type into an agent terminal. Cross-workspace ids require matching workspace_id.', parameters: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, workspace_id: { type: 'string' } }, required: ['id','text'] } } },
  { type: 'function', function: { name: 'broadcast', description: 'Send the same text to every running agent in the active workspace (optionally filter by kind).', parameters: { type: 'object', properties: { text: { type: 'string' }, kind: { type: 'string', enum: ['claude','codex','shell','gemini','python'] }, workspace_id: { type: 'string' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'read_agent_output', description: 'Read the last N lines of an agent terminal output to inspect status / errors. Cross-workspace ids require matching workspace_id.', parameters: { type: 'object', properties: { id: { type: 'string' }, lines: { type: 'number' }, workspace_id: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'list_agents', description: 'List running agents.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'create_workspace', description: 'Create workspace.', parameters: { type: 'object', properties: { name: { type: 'string' }, cwd: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'list_workspaces', description: 'List workspaces.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_dispatch_status', description: 'Return the latest or requested durable dispatch run for a workspace.', parameters: { type: 'object', properties: { workspace_id: { type: 'string' }, run_id: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_control_center_summary', description: 'Read-only multi-workspace Control Center summary with stale panes, report rows, and recommended next actions. Use workspace-scoped tools for mutations.', parameters: { type: 'object', properties: { workspace_ids: { type: 'array', items: { type: 'string' } }, runs_limit: { type: 'integer', minimum: 1, maximum: 50 }, stale_threshold_ms: { type: 'integer', minimum: 60000, maximum: 3600000 }, reports_limit: { type: 'integer', minimum: 1, maximum: 20 }, include_acked: { type: 'boolean' } } } } },
  { type: 'function', function: { name: 'acknowledge_agent', description: 'Mark an exited agent pane as reviewed for the Control Center queue. Acknowledgement does not delete the pane; it only marks the agent as reviewed for the Control Center queue. Use the manual UI button or a future clear_exited_agents tool to actually remove the pane.', parameters: { type: 'object', properties: { agent_id: { type: 'string' }, workspace_id: { type: 'string' }, reason: { type: 'string', maxLength: 200 }, by: { type: 'string', maxLength: 32 } }, required: ['agent_id'] } } },
  { type: 'function', function: { name: 'list_workspace_reports', description: 'List Control Center report artifacts recorded for one workspace.', parameters: { type: 'object', properties: { workspace_id: { type: 'string' }, reports_limit: { type: 'integer', minimum: 1, maximum: 50 }, unread_only: { type: 'boolean' } }, required: ['workspace_id'] } } },
  { type: 'function', function: { name: 'summarize_portfolio', description: 'Render a Telegram-safe portfolio rollup across workspaces (Control Center summary -> rollup -> renderer). One line per workspace, sorted actionable-first.', parameters: { type: 'object', properties: { workspaceFilter: { type: 'string' }, actionableOnly: { type: 'boolean' } } } } },
]

function cleanToolError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg.includes('agent not found')) return 'unknown agent id'
  if (msg.includes('workspace not found')) return 'unknown workspace id'
  return msg || 'tool failed'
}

async function resolveTargetWorkspace(args: Record<string, unknown>, ctx: { activeWorkspaceId?: string }): Promise<{ workspaceId?: string; explicit: boolean; error?: string }> {
  if (typeof args.workspace_id !== 'string') return { workspaceId: ctx.activeWorkspaceId, explicit: false }
  try {
    const r = await ptyApi.listWorkspaces()
    const resolved = resolveWorkspaceSelector(r.workspaces, args.workspace_id)
    if ('error' in resolved) return { explicit: true, error: resolved.error }
    return { workspaceId: resolved.workspaceId, explicit: true }
  } catch (e) {
    return { explicit: true, error: cleanToolError(e) }
  }
}

async function requireKnownAgent(id: string, ctx: { activeWorkspaceId?: string }, explicitWorkspaceId?: string): Promise<{ ok: true; targetWorkspaceId: string; explicit: boolean } | { error: string }> {
  try {
    const r = await ptyApi.listAgents({ includeExited: true })
    const resolved = resolveDirectAgentTarget({
      agents: r.agents,
      id,
      activeWorkspaceId: ctx.activeWorkspaceId,
      explicitWorkspaceId,
    })
    if ('error' in resolved) return { error: resolved.error }
    return { ok: true, targetWorkspaceId: resolved.targetWorkspaceId, explicit: resolved.explicit }
  } catch (e) {
    return { error: cleanToolError(e) }
  }
}

async function getControlCenterSummary(args: Record<string, unknown>, ctx: { activeWorkspaceId?: string }): Promise<unknown> {
  const [workspaces, agents] = await Promise.all([
    ptyApi.listWorkspaces(),
    ptyApi.listAgents({ includeExited: true }),
  ])
  const reports = detectControlCenterReports(workspaces.workspaces, agents.agents)
  const evidenceByWorkspace: Record<string, ReturnType<typeof evidenceCounts>> = {}
  for (const ws of workspaces.workspaces) {
    try { evidenceByWorkspace[ws.id] = evidenceCounts(ws.id) } catch {}
  }
  return buildControlCenterSummary({
    workspaces: workspaces.workspaces,
    agents: agents.agents,
    workspaceSelectors: Array.isArray(args.workspace_ids) ? args.workspace_ids : undefined,
    runsLimit: typeof args.runs_limit === 'number' ? args.runs_limit : undefined,
    staleThresholdMs: typeof args.stale_threshold_ms === 'number' ? args.stale_threshold_ms : undefined,
    reportsLimit: typeof args.reports_limit === 'number' ? args.reports_limit : undefined,
    includeAcked: args.include_acked === true,
    activeWorkspaceId: ctx.activeWorkspaceId,
    acks: readControlCenterAcks(),
    reports,
    evidenceByWorkspace,
  })
}

async function acknowledgeAgent(args: Record<string, unknown>, ctx: { activeWorkspaceId?: string }): Promise<unknown> {
  const target = await resolveTargetWorkspace({ workspace_id: args.workspace_id }, ctx)
  if (target.error) return { error: target.error }
  const agents = await ptyApi.listAgents({ includeExited: true })
  const agent = agents.agents.find((row) => row.id === args.agent_id)
  if (!agent) return { error: `unknown agent id: ${args.agent_id}` }
  if (target.workspaceId && agent.workspaceId !== target.workspaceId) {
    return { error: `agent ${args.agent_id} belongs to workspace ${agent.workspaceId}, not ${target.workspaceId}` }
  }
  if (agent.status !== 'exited') return { error: 'can only acknowledge exited agents' }
  return acknowledgeControlCenterAgent({
    workspaceId: agent.workspaceId,
    agentId: agent.id,
    by: typeof args.by === 'string' ? args.by : undefined,
    reason: typeof args.reason === 'string' ? args.reason : undefined,
  })
}

async function summarizePortfolioTool(args: Record<string, unknown>, ctx: { activeWorkspaceId?: string }): Promise<unknown> {
  const [workspaces, agents] = await Promise.all([
    ptyApi.listWorkspaces(),
    ptyApi.listAgents({ includeExited: true }),
  ])
  const reports = detectControlCenterReports(workspaces.workspaces, agents.agents)
  const evidenceByWorkspace: Record<string, ReturnType<typeof evidenceCounts>> = {}
  for (const ws of workspaces.workspaces) {
    try { evidenceByWorkspace[ws.id] = evidenceCounts(ws.id) } catch {}
  }
  const result = summarizePortfolio({
    workspaces: workspaces.workspaces,
    agents: agents.agents,
    workspaceFilter: typeof args.workspaceFilter === 'string' ? args.workspaceFilter : undefined,
    actionableOnly: args.actionableOnly === true,
    activeWorkspaceId: ctx.activeWorkspaceId,
    acks: readControlCenterAcks(),
    reports,
    evidenceByWorkspace,
  })
  if ('error' in result) return result
  return { text: result.text }
}

async function listWorkspaceReports(args: Record<string, unknown>, ctx: { activeWorkspaceId?: string }): Promise<unknown> {
  const target = await resolveTargetWorkspace({ workspace_id: args.workspace_id }, ctx)
  if (target.error) return { error: target.error }
  const wsId = target.workspaceId
  if (!wsId) return { error: 'no active workspace' }
  const reportsLimit = typeof args.reports_limit === 'number' ? args.reports_limit : 10
  const reports = readControlCenterReports()
    .filter((report) => report.workspaceId === wsId && (args.unread_only === true ? report.unread : true))
    .sort((a, b) => b.mtime.localeCompare(a.mtime) || a.path.localeCompare(b.path))
    .slice(0, reportsLimit)
    .map(({ workspaceId: _workspaceId, ...report }) => report)
  return { reports }
}

async function execToolRaw(name: string, args: any, ctx: { activeWorkspaceId?: string }): Promise<unknown> {
  const valid = validateToolCall(name, args)
  if ('error' in valid) return { error: valid.error }
  args = valid.args

  switch (name) {
    case 'spawn_agents': {
      const target = await resolveTargetWorkspace(args, ctx)
      if (target.error) return { error: target.error }
      const wsId = target.workspaceId
      if (!wsId) return { error: 'no active workspace' }
      const out: any[] = []
      for (const spec of args.specs ?? []) {
        try {
          const r = await ptyApi.spawnAgent({
            workspaceId: wsId,
            kind: spec.kind as AgentKind,
            name: spec.name,
            cmd: spec.cmd,
            args: spec.args,
            cwd: spec.cwd,
            initialPrompt: typeof spec.initial_prompt === 'string' && spec.initial_prompt.trim() ? spec.initial_prompt : undefined,
          })
          out.push({ id: r.agent.id, name: r.agent.name, kind: r.agent.kind, pid: r.agent.pid })
        } catch (e) { out.push({ error: e instanceof Error ? e.message : 'spawn failed', spec }) }
      }
      return { spawned: out }
    }
    case 'kill_agent': {
      const target = await resolveTargetWorkspace(args, ctx)
      if (target.error) return { error: target.error }
      const known = await requireKnownAgent(args.id, ctx, target.explicit ? target.workspaceId : undefined)
      if ('error' in known) return { error: known.error }
      try { return await ptyApi.killAgent(args.id) } catch (e) { return { error: cleanToolError(e) } }
    }
    case 'rename_agent': {
      const target = await resolveTargetWorkspace(args, ctx)
      if (target.error) return { error: target.error }
      const known = await requireKnownAgent(args.id, ctx, target.explicit ? target.workspaceId : undefined)
      if ('error' in known) return { error: known.error }
      try { return await ptyApi.renameAgent(args.id, args.name) } catch (e) { return { error: cleanToolError(e) } }
    }
    case 'send_to_agent': {
      const target = await resolveTargetWorkspace(args, ctx)
      if (target.error) return { error: target.error }
      const known = await requireKnownAgent(args.id, ctx, target.explicit ? target.workspaceId : undefined)
      if ('error' in known) return { error: known.error }
      // Auto-submit: append \r if not already terminated, unless caller explicitly opts out
      const text = autoSubmitText(args.text, args.submit)
      try { return await ptyApi.sendInput(args.id, text) } catch (e) { return { error: cleanToolError(e) } }
    }
    case 'broadcast': {
      const target = await resolveTargetWorkspace(args, ctx)
      if (target.error) return { error: target.error }
      const wsId = target.workspaceId
      if (!wsId) return { error: 'no active workspace' }
      const text = autoSubmitText(args.text, args.submit)
      return ptyApi.broadcast(wsId, text, args.kind)
    }
    case 'read_agent_output': {
      const target = await resolveTargetWorkspace(args, ctx)
      if (target.error) return { error: target.error }
      const known = await requireKnownAgent(args.id, ctx, target.explicit ? target.workspaceId : undefined)
      if ('error' in known) return { error: known.error }
      try { return await ptyApi.scrollback(args.id, args.lines ?? 200) } catch (e) { return { error: cleanToolError(e) } }
    }
    case 'list_agents': return ptyApi.listAgents()
    case 'create_workspace': return ptyApi.createWorkspace({ name: args.name, cwd: args.cwd })
    case 'list_workspaces': return ptyApi.listWorkspaces()
    case 'get_dispatch_status': {
      const target = await resolveTargetWorkspace(args, ctx)
      if (target.error) return { error: target.error }
      const wsId = target.workspaceId
      if (!wsId) return { error: 'no active workspace' }
      return target.explicit ? dispatchRunStatus(wsId, args.run_id) : dispatchRunStatusForSession(wsId, args.run_id)
    }
    case 'get_control_center_summary':
      return getControlCenterSummary(args, ctx)
    case 'acknowledge_agent':
      return acknowledgeAgent(args, ctx)
    case 'list_workspace_reports':
      return listWorkspaceReports(args, ctx)
    case 'summarize_portfolio':
      return summarizePortfolioTool(args, ctx)
    default: return { error: `unknown tool ${name}` }
  }
}

async function execTool(name: string, args: any, ctx: {
  activeWorkspaceId?: string
  dispatchRunId?: string
  actionId?: string
  createdBy?: string
  userPrompt?: string
}): Promise<unknown> {
  const valid = validateToolCall(name, args)
  if ('error' in valid) return { error: valid.error }
  const tool = valid.tool
  const validArgs = valid.args
  const target = await resolveTargetWorkspace(validArgs, ctx)
  if (target.error) return { error: target.error }
  const wsId = target.workspaceId
  if (!wsId || tool === 'list_workspaces' || tool === 'create_workspace' || tool === 'get_dispatch_status' || tool === 'get_control_center_summary' || tool === 'acknowledge_agent' || tool === 'list_workspace_reports' || tool === 'summarize_portfolio') {
    return execToolRaw(tool, validArgs, ctx)
  }

  const runId = synthesizeDispatchRunId({
    workspaceId: wsId,
    userPrompt: ctx.userPrompt,
    explicitRunId: ctx.dispatchRunId,
  })
  const actionId = ctx.actionId || `${tool}:${runId}`
  const begun = beginDispatchAction({
    runId,
    workspaceId: wsId,
    createdBy: ctx.createdBy ?? 'workbench-assistant',
    userPrompt: ctx.userPrompt ?? '',
    actionId,
    tool,
    args: validArgs,
    sessionWorkspaceId: ctx.activeWorkspaceId,
    targetWorkspaceId: wsId,
    explicitTargetWorkspaceId: target.explicit ? wsId : undefined,
  })
  if (begun.duplicate) {
    return {
      already_applied: true,
      runId,
      actionId: begun.action.actionId,
      status: begun.action.status,
      result: begun.action.result,
      error: begun.action.error,
      spawnedAgents: begun.action.spawnedAgents,
      failedSpecs: begun.action.failedSpecs,
    }
  }

  try {
    const result = await execToolRaw(tool, validArgs, ctx)
    completeDispatchAction({ workspaceId: wsId, runId, actionId: begun.action.actionId, tool, result })
    return result
  } catch (e) {
    const error = e instanceof Error ? e.message : 'exec error'
    completeDispatchAction({ workspaceId: wsId, runId, actionId: begun.action.actionId, tool, error })
    throw e
  }
}

// ---------- provider resolution ----------

async function pickProvider(persona: NormalizedAssistantPersona = 'metis-brain'): Promise<'openclaw' | 'openai' | CliProvider | null> {
  const s = readSettings()
  if (s.assistantProvider === 'openclaw') return 'openclaw'
  if (s.assistantProvider === 'claude-cli' || s.assistantProvider === 'codex-cli') {
    return s.assistantProvider
  }
  if (s.assistantProvider === 'openai' && effectiveOpenAIKey()) return 'openai'

  // auto / unset: Metis Brain should use the canonical OpenClaw gateway first.
  if (persona === 'metis-brain') return 'openclaw'

  const auth = await getAuthStatus()
  if (auth.claude.signedIn) return 'claude-cli'
  if (auth.codex.signedIn) return 'codex-cli'
  if (auth.openai.hasKey) return 'openai'
  return null
}

// ---------- CLI brain path ----------

function buildCliSystem(activeWorkspaceId?: string, persona: NormalizedAssistantPersona = 'workbench'): string {
  if (persona === 'metis-brain') {
    const ident = loadMetisBrainIdentity()
    const preamble = METIS_BRAIN_WORKBENCH_PREAMBLE + `\n\nActive workspace: ${activeWorkspaceId ?? '(none)'}.`
    return ident.available
      ? `${ident.text}\n\n---\n\n${preamble}\n\n${toolDescriptions}`
      : `${preamble}\n\n${toolDescriptions}\n\n(Note: workspace identity files at ~/.openclaw/workspace/{SOUL,USER,IDENTITY,AGENTS}.md were not readable, so I'm operating from the bare Metis Brain preamble.)`
  }
  return `You are the in-app operator for Metis Command Center.
You can spawn and steer CLI agents (Claude Code, Codex, shells, Gemini, Python REPL).

You CANNOT call tools directly. Instead, when you need to perform an action, emit ONE fenced block then STOP:

\`\`\`aw_action
{"tool":"<name>","args":{...}}
\`\`\`

The system will execute and reply with the result. You may emit further action blocks based on results. When done, respond with a short plain-text confirmation (no action block).

${toolDescriptions}

Active workspace: ${activeWorkspaceId ?? '(none)'}.
Be terse. For "open 2 claude code, 1 codex", emit ONE action block with spawn_agents and a single specs array.`
}

function flattenHistory(messages: { role: string; content: string; attachments?: Attachment[] }[]): string {
  return messages.map((m) => {
    let body = m.content
    if (m.role === 'user' && m.attachments && m.attachments.length > 0) {
      // Persist images to disk so the CLI agent can read them by path
      const persisted = persistImageAttachments(m.attachments.filter((a) => a.type === 'image'))
      if (persisted.length > 0) {
        const refs = persisted.map((p) => `Image attached at: ${p.path}`).join('\n')
        body = body ? `${body}\n\n${refs}` : refs
      }
    }
    return `[${m.role.toUpperCase()}] ${body}`
  }).join('\n\n')
}

function lastUserPrompt(messages: { role: string; content: string }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return messages[i].content ?? ''
  }
  return ''
}

interface CliTurnLog { id: string; name: string; arguments: string; result: unknown; ledger?: TurnActionLedgerEntry }

interface WorkbenchRequestContext {
  activeWorkspaceId?: string
  activeWorkspaceName?: string
  activeWorkspaceCwd?: string
  visiblePaneSummary?: string
  dispatchSummary?: string
}

function workspaceContextLines(ctx: WorkbenchRequestContext): string[] {
  return [
    `Active Workbench workspace id: ${ctx.activeWorkspaceId ?? '(none)'}.`,
    `Active Workbench workspace name: ${ctx.activeWorkspaceName ?? '(unknown)'}.`,
    `Active Workbench cwd: ${ctx.activeWorkspaceCwd ?? '(unknown)'}.`,
    `Visible pane summary: ${ctx.visiblePaneSummary ?? '(not provided)'}.`,
    `Recent dispatch summary: ${ctx.dispatchSummary ?? '(none)'}.`,
  ]
}

function summarizeDispatchContext(workspaceId?: string): string | undefined {
  if (!workspaceId) return undefined
  const status = dispatchRunStatusForSession(workspaceId)
  const runs = status.runs ?? (status.run ? [status.run] : [])
  if (runs.length === 0) return undefined
  return runs.slice(0, 3).map((run) => {
    const target = run.targetWorkspaceId && run.targetWorkspaceId !== workspaceId
      ? ` target=${run.targetWorkspaceId}`
      : ''
    const spawned = run.actions.flatMap((a) => a.spawnedAgents.map((agent) => agent.id))
    const failed = run.actions.reduce((n, a) => n + (a.failedSpecs?.length ?? 0), 0)
    const extras = [
      target,
      spawned.length ? ` spawned=${spawned.join(',')}` : '',
      failed ? ` failed_specs=${failed}` : '',
    ].join('')
    return `${run.runId} status=${run.status} actions=${run.actions.length}${extras}`
  }).join(' | ')
}

async function resolveWorkbenchContext(body: any): Promise<WorkbenchRequestContext> {
  const ctx: WorkbenchRequestContext = {
    activeWorkspaceId: typeof body.activeWorkspaceId === 'string' ? body.activeWorkspaceId : undefined,
    activeWorkspaceName: typeof body.activeWorkspaceName === 'string' ? body.activeWorkspaceName : undefined,
    activeWorkspaceCwd: typeof body.activeWorkspaceCwd === 'string' ? body.activeWorkspaceCwd : undefined,
    visiblePaneSummary: typeof body.visiblePaneSummary === 'string' ? body.visiblePaneSummary : undefined,
  }

  try {
    const [workspaces, agents] = await Promise.all([ptyApi.listWorkspaces(), ptyApi.listAgents()])
    const active = workspaces.workspaces.find((w) => w.id === ctx.activeWorkspaceId)
    if (active) {
      ctx.activeWorkspaceName ??= active.name
      ctx.activeWorkspaceCwd ??= active.cwd
      if (!ctx.visiblePaneSummary) {
        const panes = agents.agents
          .filter((a) => a.workspaceId === active.id)
          .map((a) => `${a.id}:${a.kind}:${a.name}:${a.status}`)
        ctx.visiblePaneSummary = panes.length ? panes.join(', ') : 'no agents in active workspace'
      }
      ctx.dispatchSummary ??= summarizeDispatchContext(active.id)
    }
  } catch {}

  return ctx
}

function gatewayMetadata(ctx: WorkbenchRequestContext): WorkbenchGatewayMetadata {
  return {
    surface: 'metis-command',
    activeWorkspaceId: ctx.activeWorkspaceId,
    activeWorkspaceName: ctx.activeWorkspaceName,
    activeWorkspaceCwd: ctx.activeWorkspaceCwd,
    visiblePaneSummary: ctx.visiblePaneSummary,
  }
}

async function runCliConversation(provider: CliProvider, messages: { role: string; content: string; attachments?: Attachment[] }[], ctx: WorkbenchRequestContext, opts: { persona?: NormalizedAssistantPersona; hopCap?: number; dispatchRunId?: string } = {}) {
  const activeWorkspaceId = ctx.activeWorkspaceId
  const persona = opts.persona ?? 'workbench'
  const userPrompt = lastUserPrompt(messages)
  const dispatchRunId = synthesizeDispatchRunId({ workspaceId: activeWorkspaceId, userPrompt, explicitRunId: opts.dispatchRunId })
  // Soft cap: how many hops before we *consider* stopping. Hard cap: absolute ceiling.
  const softCap = Math.max(1, Math.min(40, opts.hopCap ?? 4))
  const hardCap = Math.max(softCap, Math.min(60, softCap * 2))
  const system = buildCliSystem(activeWorkspaceId, persona)
  // For Metis Brain, run claude from ~/.openclaw/workspace so it has full canonical context.
  // Session identity stays Workbench-scoped; cwd context is not used as a chat-session key.
  const brainCwd = persona === 'metis-brain'
    ? (process.env.METIS_BRAIN_CWD || process.env.AW_JARVIS_CWD || `${process.env.HOME}/.openclaw/workspace`)
    : undefined
  let transcript = flattenHistory(messages)
  const toolCalls: CliTurnLog[] = []
  let finalText = ''
  let lastTurnHadActions = false

  for (let hop = 0; hop < hardCap; hop++) {
    const res = await runCliBrain({ provider, prompt: transcript, systemPrompt: system, cwd: brainCwd, timeoutMs: 180_000 })
    if (!res.ok) {
      // Return any work already done so the user sees the agents that DID get spawned/dispatched.
      const isTimeout = (res.error ?? '').toLowerCase().includes('timeout')
      const friendlyText = isTimeout
        ? `(${persona === 'metis-brain' ? 'Metis Brain' : 'assistant'} hit a CLI timeout after ${toolCalls.length} successful action(s) at hop ${hop + 1}/${hardCap}. The actions above already ran — agents that were spawned are live in the panes. Send another message to continue.)`
        : `(brain error: ${res.error || 'unknown'}. ${toolCalls.length} action(s) completed before the failure.)`
      return { message: { role: 'assistant', content: friendlyText }, toolCalls }
    }
    const reply = res.text || ''
    const preparedActions = prepareCurrentTurnActions(reply)
    if (preparedActions.length === 0) {
      finalText = reply.trim()
      break
    }
    // Execute ALL action blocks emitted this turn (parallel dispatch in one reply)
    const turnResults: Array<{ tool: string; args: any; result: unknown; error?: string }> = []
    for (const prepared of preparedActions) {
      const ledger = prepared.ledgerEntry
      if ('error' in prepared) {
        turnResults.push({ tool: ledger.tool, args: {}, result: ledger.result ?? null, error: prepared.error })
        toolCalls.push({ id: ledger.actionId, name: ledger.tool, arguments: '{}', result: ledger.result ?? { error: prepared.error }, ledger })
        continue
      }
      const parsed = prepared.action
      try {
        const result = await execTool(parsed.tool, parsed.args || {}, {
          activeWorkspaceId,
          dispatchRunId,
          actionId: ledger.actionId,
          createdBy: persona,
          userPrompt,
        })
        ledger.result = result
        turnResults.push({ tool: parsed.tool, args: parsed.args ?? {}, result })
        toolCalls.push({ id: ledger.actionId, name: parsed.tool, arguments: JSON.stringify(parsed.args ?? {}), result, ledger })
      } catch (e) {
        ledger.error = e instanceof Error ? e.message : 'exec error'
        turnResults.push({ tool: parsed.tool, args: parsed.args ?? {}, result: null, error: ledger.error })
      }
    }
    const resultsBlock = turnResults.map((r, i) =>
      `[TOOL_RESULT ${i + 1}/${turnResults.length} for ${r.tool}]\n${JSON.stringify(r.error ? { error: r.error } : r.result)}`
    ).join('\n\n')
    transcript += `\n\n[ASSISTANT]\n${reply}\n\n${resultsBlock}\n\nContinue. If the goal is fully dispatched, reply with a short confirmation and no action blocks.`
    lastTurnHadActions = true

    // Soft cap reached but the brain is still actively dispatching: extend silently up to hardCap.
    if (hop + 1 === softCap && lastTurnHadActions) {
      transcript += `\n\n[SYSTEM] You are at hop ${hop + 1} of an extended budget (hard cap ${hardCap}). Wrap up: dispatch any remaining agents in this turn, then send a short confirmation in the next turn with no action blocks.`
    }
  }
  if (!finalText) {
    const ranOut = toolCalls.length
    finalText = ranOut > 0
      ? `(hit the hard hop ceiling at ${hardCap} after ${ranOut} action(s); the agents already dispatched are running in the panes — say "continue" if you want me to pick up where I left off.)`
      : `(no progress this turn — the brain didn't emit any action blocks. Try rephrasing the request.)`
  }
  return { message: { role: 'assistant', content: finalText }, toolCalls }
}

// ---------- OpenAI path ----------

/** Build OpenAI content array (text + image_url blocks) for a message that may have attachments. */
function openAIContentForMessage(m: { role: string; content: string; attachments?: Attachment[] }) {
  const parts: any[] = []
  if (m.content) parts.push({ type: 'text', text: m.content })
  for (const a of m.attachments ?? []) {
    if (a.type === 'image') parts.push({ type: 'image_url', image_url: { url: a.dataUrl } })
  }
  if (parts.length === 0) return ''
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text
  return parts
}

async function runOpenAI(messages: { role: string; content: string; attachments?: Attachment[] }[], ctx: WorkbenchRequestContext, opts: { persona?: NormalizedAssistantPersona; hopCap?: number; dispatchRunId?: string } = {}) {
  const activeWorkspaceId = ctx.activeWorkspaceId
  const userPrompt = lastUserPrompt(messages)
  const dispatchRunId = synthesizeDispatchRunId({ workspaceId: activeWorkspaceId, userPrompt, explicitRunId: opts.dispatchRunId })
  const apiKey = effectiveOpenAIKey()
  if (!apiKey) return { error: 'no OpenAI key' }
  const { primary: MODEL, fallback: FALLBACK_MODEL } = effectiveModel()
  const client = new OpenAI({ apiKey })

  const persona = opts.persona ?? 'workbench'
  const hopCap = Math.max(1, Math.min(20, opts.hopCap ?? 4))
  let systemContent: string
  if (persona === 'metis-brain') {
    const ident = loadMetisBrainIdentity()
    systemContent = ident.available
      ? `${ident.text}\n\n---\n\n${METIS_BRAIN_WORKBENCH_PREAMBLE}\n\n${workspaceContextLines(ctx).join('\n')}\nUse the function tools (do not emit action blocks — you have native tool calls).`
      : `${METIS_BRAIN_WORKBENCH_PREAMBLE}\n\n${workspaceContextLines(ctx).join('\n')}\nUse the function tools.`
  } else {
    systemContent = `You are the Metis Assistant. Use tools to spawn/steer CLI agents.\n${workspaceContextLines(ctx).join('\n')}\nBe terse.`
  }
  const sys: OpenAI.Chat.ChatCompletionMessageParam = { role: 'system', content: systemContent }
  // Convert any user messages with attachments to OpenAI multimodal content arrays
  const upgradedMessages = messages.map((m: any) => {
    if (m.role === 'user' && Array.isArray(m.attachments) && m.attachments.length > 0) {
      return { role: 'user', content: openAIContentForMessage(m) }
    }
    return { role: m.role, content: m.content }
  })
  const callMessages: any[] = [sys, ...upgradedMessages]
  const toolCallLog: any[] = []

  async function call(model: string) {
    return client.chat.completions.create({ model, messages: callMessages, tools: openAITools, tool_choice: 'auto' })
  }
  for (let hop = 0; hop < hopCap; hop++) {
    let resp
    try { resp = await call(MODEL) } catch { resp = await call(FALLBACK_MODEL) }
    const msg = resp.choices[0]?.message
    if (!msg) break
    callMessages.push(msg)
    const toolCalls = msg.tool_calls ?? []
    if (toolCalls.length === 0) return { message: msg, toolCalls: toolCallLog }
    for (const tc of toolCalls) {
      if (tc.type !== 'function') continue
      let parsed: any = {}
      try { parsed = JSON.parse(tc.function.arguments || '{}') } catch (e) {
        const result = { error: `invalid tool arguments JSON: ${e instanceof Error ? e.message : 'parse error'}` }
        toolCallLog.push({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments, result })
        callMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) })
        continue
      }
      const valid = validateToolCall(tc.function.name, parsed)
      const result = 'error' in valid
        ? { error: valid.error }
        : await execTool(valid.tool, valid.args, {
          activeWorkspaceId,
          dispatchRunId,
          actionId: tc.id,
          createdBy: persona,
          userPrompt,
        })
      toolCallLog.push({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments, result })
      callMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) })
    }
  }
  return { message: { role: 'assistant', content: '(stopped after 4 tool hops)' }, toolCalls: toolCallLog }
}

// ---------- OpenClaw canonical Metis Brain path ----------

function openClawPrompt(messages: { role: string; content: string; attachments?: Attachment[] }[], ctx: WorkbenchRequestContext): string {
  const transcript = flattenHistory(messages)
  return [
    `You are being contacted from Metis Command Center, Ant's deep-work Control Center.`,
    `Use the same Metis Brain/OpenClaw identity, but this is an isolated Metis Command Center session. Do not include Telegram inbound metadata or route Command Center directives to Telegram.`,
    ...workspaceContextLines(ctx),
    ``,
    `# Metis Command Center tools`,
    `When the user asks to spawn agents / build a project / dispatch a swarm / open the workbench / decompose modules, you MUST act on it through the workbench by emitting fenced action blocks. The workbench will execute every block before your next turn and feed the results back as a [SYSTEM] message — you can chain (spawn → dispatch → confirm).`,
    ``,
    `Format — emit one or MORE blocks per reply:`,
    "```aw_action",
    `{"tool": "<name>", "args": { ... }}`,
    "```",
    ``,
    toolDescriptions,
    ``,
    `Rules:`,
    `- Fan out in ONE reply when work splits across N agents (emit N action blocks, not one per turn).`,
    `- Dispatched text is auto-submitted (\\r appended) so agents start immediately.`,
    `- For non-orchestration questions (chat, status, memory recall), reply with plain text and NO action blocks.`,
    `- When the goal is fully dispatched, reply with a short confirmation and no action blocks.`,
    ``,
    `# Conversation`,
    transcript,
  ].join('\n')
}

/**
 * Drive OpenClaw (Gateway → CLI runtime fallback) and execute any aw_action
 * blocks the response contains. Loops up to hopCap so Metis Brain can iterate
 * (spawn → read → dispatch → confirm) the same way the CLI brain path does.
 */
async function runOpenClawConversation(messages: { role: string; content: string; attachments?: Attachment[] }[], ctx: WorkbenchRequestContext, opts: { timeoutSeconds?: number; hopCap?: number; dispatchRunId?: string } = {}) {
  const activeWorkspaceId = ctx.activeWorkspaceId
  const userPrompt = lastUserPrompt(messages)
  const dispatchRunId = synthesizeDispatchRunId({ workspaceId: activeWorkspaceId, userPrompt, explicitRunId: opts.dispatchRunId })
  const timeoutMs = Math.max(120_000, Math.min(1_800_000, (opts.timeoutSeconds ?? 600) * 1000))
  const gatewayTimeoutMs = Math.max(30_000, Math.min(45_000, timeoutMs))
  const softCap = Math.max(1, Math.min(40, opts.hopCap ?? 12))
  const hardCap = Math.max(softCap, Math.min(60, softCap * 2))

  // We'll feed the conversation back into OpenClaw on each hop, accumulating
  // tool results so Metis Brain can chain (spawn → dispatch → confirm).
  const turns = [...messages]
  const toolCalls: Array<{ id: string; name: string; arguments: string; result: unknown }> = []
  let finalText = ''
  const sessionKey = buildWorkbenchSessionKey(activeWorkspaceId)

  for (let hop = 0; hop < hardCap; hop++) {
    const message = openClawPrompt(turns, ctx)

    // Try Gateway first; fall back to CLI bridge if it returns nothing.
    let replyText = ''
    let gatewayRunId: string | undefined
    const gateway = await runOpenClawGatewayChat({ message, timeoutMs: gatewayTimeoutMs, sessionKey, metadata: gatewayMetadata(ctx) })
    if (gateway.ok && gateway.text.trim()) {
      replyText = gateway.text.trim()
      gatewayRunId = gateway.runId
    } else {
      const res = await runOpenClawMetisBrainTurn({ message, timeoutSeconds: opts.timeoutSeconds ?? 600, sessionKey })
      if (!res.ok) {
        if (toolCalls.length > 0) break // surface what's already done
        return { error: `${gateway.error || 'Gateway bridge failed'}; CLI fallback: ${res.error || 'OpenClaw runtime error'}`, toolCalls: [] }
      }
      replyText = (res.text || '').trim()
    }

    const preparedActions = prepareCurrentTurnActions(replyText)
    if (preparedActions.length === 0) {
      finalText = replyText || finalText
      break
    }

    // Execute every action block emitted this turn (parallel dispatch in one reply).
    const turnResults: Array<{ tool: string; args: any; result: unknown; error?: string }> = []
    for (const prepared of preparedActions) {
      const ledger = prepared.ledgerEntry
      if ('error' in prepared) {
        turnResults.push({ tool: ledger.tool, args: {}, result: ledger.result ?? null, error: prepared.error })
        toolCalls.push({
          id: ledger.actionId,
          name: ledger.tool,
          arguments: '{}',
          result: ledger.result ?? { error: prepared.error },
        })
        continue
      }
      const parsed = prepared.action
      try {
        const result = await execTool(parsed.tool, parsed.args || {}, {
          activeWorkspaceId,
          dispatchRunId,
          actionId: ledger.actionId,
          createdBy: 'metis-brain',
          userPrompt,
        })
        ledger.result = result
        turnResults.push({ tool: parsed.tool, args: parsed.args ?? {}, result })
        toolCalls.push({
          id: parsed.id ?? ledger.actionId ?? `${gatewayRunId ?? 'oc'}_h${hop}_${toolCalls.length}`,
          name: parsed.tool,
          arguments: JSON.stringify(parsed.args ?? {}),
          result,
        })
      } catch (e) {
        ledger.error = e instanceof Error ? e.message : 'exec error'
        turnResults.push({ tool: parsed.tool, args: parsed.args ?? {}, result: null, error: ledger.error })
      }
    }
    const resultsBlock = turnResults.map((r, i) =>
      `[TOOL_RESULT ${i + 1}/${turnResults.length} for ${r.tool}]\n${JSON.stringify(r.error ? { error: r.error } : r.result)}`
    ).join('\n\n')

    // Feed back as a synthetic user turn so the next gateway round sees prior actions + their results.
    turns.push({ role: 'assistant', content: replyText })
    turns.push({ role: 'user', content: `[SYSTEM] Tool execution results:\n\n${resultsBlock}\n\nContinue. If the goal is fully dispatched, reply with a short confirmation and no action blocks.` })
  }

  if (!finalText) {
    finalText = toolCalls.length > 0
      ? `(executed ${toolCalls.length} action(s) and stopped — agents that were spawned are live in the panes. Say "continue" if you want me to keep going.)`
      : '(OpenClaw finished with no visible text and no action blocks.)'
  }
  return { message: { role: 'assistant', content: finalText }, toolCalls }
}

// ---------- request handler ----------

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const settings = readSettings()

  // Optional bearer token for remote bridges (Telegram etc.) to call this endpoint.
  if (settings.bridgeApiKey) {
    const got = req.headers.get('authorization')?.replace(/^bearer\s+/i, '')
    const isLocal = (req.headers.get('host') || '').startsWith('127.0.0.1') || (req.headers.get('host') || '').startsWith('localhost')
    if (!isLocal && got !== settings.bridgeApiKey) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
  }

  const url = new URL(req.url)
  if (url.searchParams.get('scope') === 'acknowledge_agent') {
    const valid = validateToolCall('acknowledge_agent', body)
    if ('error' in valid) return NextResponse.json({ error: valid.error }, { status: 400 })
    const result = await acknowledgeAgent(valid.args, { activeWorkspaceId: typeof body.activeWorkspaceId === 'string' ? body.activeWorkspaceId : undefined })
    if (result && typeof result === 'object' && 'error' in result) return NextResponse.json(result, { status: 400 })
    return NextResponse.json(result)
  }

  const messages = body.messages ?? []
  const ctx = await resolveWorkbenchContext(body)
  const persona = normalizeAssistantPersona(body.persona ?? settings.assistantPersona ?? 'metis-brain')
  // Metis Brain defaults to autonomous mode unless the caller explicitly asks for auto:false.
  // Workbench persona stays manual unless the caller asks for auto:true.
  const auto: boolean = body.auto === undefined ? (persona === 'metis-brain') : !!body.auto
  const hopCap = auto ? (settings.autonomousHopCap ?? 20) : 4
  const dispatchRunId = synthesizeDispatchRunId({
    workspaceId: ctx.activeWorkspaceId,
    userPrompt: lastUserPrompt(messages),
    explicitRunId: typeof body.dispatchRunId === 'string' ? body.dispatchRunId : undefined,
  })

  const provider = await pickProvider(persona)
  if (!provider) {
    return NextResponse.json({
      error: 'No assistant brain configured. Open Settings → sign in with Claude or Codex (OAuth, no API key needed) — or paste an OpenAI API key.',
    }, { status: 401 })
  }

  try {
    if (provider === 'openclaw') {
      const r = await runOpenClawConversation(messages, ctx, {
        timeoutSeconds: Math.max(120, Math.min(1800, hopCap * 60)),
        hopCap,
        dispatchRunId,
      })
      if ('error' in r) return NextResponse.json({ error: r.error, toolCalls: r.toolCalls }, { status: 500 })
      return NextResponse.json({ message: r.message, toolCalls: r.toolCalls, provider, persona, hopCap, dispatchRunId })
    }
    if (provider === 'openai') {
      const r = await runOpenAI(messages, ctx, {
        persona,
        hopCap,
        dispatchRunId,
      })
      if ('error' in r) return NextResponse.json({ error: r.error, toolCalls: [] }, { status: 500 })
      return NextResponse.json({ message: r.message, toolCalls: r.toolCalls, provider, persona, hopCap, dispatchRunId })
    }
    const r = await runCliConversation(provider, messages, ctx, {
      persona,
      hopCap,
      dispatchRunId,
    })
    if ('error' in r) return NextResponse.json({ error: r.error, toolCalls: r.toolCalls }, { status: 500 })
    return NextResponse.json({ message: r.message, toolCalls: r.toolCalls, provider, persona, hopCap, dispatchRunId })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'assistant error' }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  const settings = readSettings()
  if (settings.bridgeApiKey) {
    const got = req.headers.get('authorization')?.replace(/^bearer\s+/i, '')
    const isLocal = (req.headers.get('host') || '').startsWith('127.0.0.1') || (req.headers.get('host') || '').startsWith('localhost')
    if (!isLocal && got !== settings.bridgeApiKey) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
  }
  const url = new URL(req.url)
  if (url.searchParams.get('scope') === 'control-center') {
    const rawWorkspaceIds = url.searchParams.get('workspace_ids')
    const rawRunsLimit = url.searchParams.get('runs_limit')
    const rawActiveWorkspaceId = url.searchParams.get('active_workspace_id')
    const rawStaleThresholdMs = url.searchParams.get('stale_threshold_ms')
    const rawReportsLimit = url.searchParams.get('reports_limit')
    const rawIncludeAcked = url.searchParams.get('include_acked')
    let runsLimit: number | undefined
    let staleThresholdMs: number | undefined
    let reportsLimit: number | undefined
    if (rawRunsLimit !== null) runsLimit = Number(rawRunsLimit)
    if (rawStaleThresholdMs !== null) staleThresholdMs = Number(rawStaleThresholdMs)
    if (rawReportsLimit !== null) reportsLimit = Number(rawReportsLimit)
    if (runsLimit !== undefined && (!Number.isInteger(runsLimit) || runsLimit < 1 || runsLimit > 50)) {
      return NextResponse.json({ error: 'runs_limit must be an integer between 1 and 50' }, { status: 400 })
    }
    if (staleThresholdMs !== undefined && (!Number.isInteger(staleThresholdMs) || staleThresholdMs < 60_000 || staleThresholdMs > 3_600_000)) {
      return NextResponse.json({ error: 'stale_threshold_ms must be an integer between 60000 and 3600000' }, { status: 400 })
    }
    if (reportsLimit !== undefined && (!Number.isInteger(reportsLimit) || reportsLimit < 1 || reportsLimit > 20)) {
      return NextResponse.json({ error: 'reports_limit must be an integer between 1 and 20' }, { status: 400 })
    }
    try {
      const summary = await getControlCenterSummary({
        workspace_ids: rawWorkspaceIds ? rawWorkspaceIds.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        runs_limit: runsLimit,
        stale_threshold_ms: staleThresholdMs,
        reports_limit: reportsLimit,
        include_acked: rawIncludeAcked === 'true',
      }, { activeWorkspaceId: rawActiveWorkspaceId ?? undefined })
      if (summary && typeof summary === 'object' && 'error' in summary) {
        return NextResponse.json(summary, { status: 400 })
      }
      return NextResponse.json(summary)
    } catch (e) {
      return NextResponse.json({ error: cleanToolError(e) }, { status: 500 })
    }
  }
  const workspaceId = url.searchParams.get('workspaceId') || url.searchParams.get('workspace_id')
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })
  const runId = url.searchParams.get('runId') || url.searchParams.get('run_id') || undefined
  return NextResponse.json(dispatchRunStatusForSession(workspaceId, runId))
}
