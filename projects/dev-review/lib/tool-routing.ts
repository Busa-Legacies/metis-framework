import type { Agent, AgentKind } from './types'

export const ROUTABLE_AGENT_KINDS: AgentKind[] = ['claude', 'codex', 'shell', 'gemini', 'python', 'custom']
export const BROADCAST_AGENT_KINDS: AgentKind[] = ['claude', 'codex', 'shell', 'gemini', 'python']

export type ToolName =
  | 'spawn_agents'
  | 'kill_agent'
  | 'rename_agent'
  | 'send_to_agent'
  | 'broadcast'
  | 'read_agent_output'
  | 'list_agents'
  | 'list_workspaces'
  | 'create_workspace'
  | 'get_dispatch_status'
  | 'get_control_center_summary'
  | 'acknowledge_agent'
  | 'list_workspace_reports'
  | 'summarize_portfolio'

const TOOL_NAMES: ToolName[] = [
  'spawn_agents',
  'kill_agent',
  'rename_agent',
  'send_to_agent',
  'broadcast',
  'read_agent_output',
  'list_agents',
  'list_workspaces',
  'create_workspace',
  'get_dispatch_status',
  'get_control_center_summary',
  'acknowledge_agent',
  'list_workspace_reports',
  'summarize_portfolio',
]

export interface ActionBlock {
  id?: string
  tool: ToolName
  args: Record<string, unknown>
}

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === 'string' && ROUTABLE_AGENT_KINDS.includes(value as AgentKind)
}

export function isBroadcastKind(value: unknown): value is AgentKind {
  return typeof value === 'string' && BROADCAST_AGENT_KINDS.includes(value as AgentKind)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasString(args: Record<string, unknown>, name: string): string | null {
  const value = args[name]
  return typeof value === 'string' && value.length > 0 ? null : `${name} must be a non-empty string`
}

function optionalString(args: Record<string, unknown>, name: string, tool: string): string | null {
  const value = args[name]
  return value === undefined || (typeof value === 'string' && value.length > 0)
    ? null
    : `${tool}.args.${name} must be a non-empty string when provided`
}

export function validateToolCall(tool: unknown, argsInput: unknown): ActionBlock | { error: string } {
  if (typeof tool !== 'string' || tool.length === 0) return { error: 'action block field "tool" must be a non-empty string' }
  if (!TOOL_NAMES.includes(tool as ToolName)) return { error: `unknown tool "${tool}"` }
  if (argsInput !== undefined && !isRecord(argsInput)) return { error: 'action block field "args" must be a JSON object' }

  const args = (argsInput ?? {}) as Record<string, unknown>
  switch (tool as ToolName) {
    case 'spawn_agents': {
      if (!Array.isArray(args.specs)) return { error: 'spawn_agents.args.specs must be an array' }
      for (let i = 0; i < args.specs.length; i++) {
        const spec = args.specs[i]
        if (!isRecord(spec)) return { error: `spawn_agents.args.specs[${i}] must be an object` }
        if (!isAgentKind(spec.kind)) return { error: `spawn_agents.args.specs[${i}].kind must be one of ${ROUTABLE_AGENT_KINDS.join(', ')}` }
        const nameErr = hasString(spec, 'name')
        if (nameErr) return { error: `spawn_agents.args.specs[${i}].${nameErr}` }
        if (spec.args !== undefined && (!Array.isArray(spec.args) || spec.args.some((v) => typeof v !== 'string'))) {
          return { error: `spawn_agents.args.specs[${i}].args must be an array of strings` }
        }
      }
      break
    }
    case 'kill_agent':
    case 'read_agent_output': {
      const err = hasString(args, 'id')
      if (err) return { error: `${tool}.args.${err}` }
      const wsErr = optionalString(args, 'workspace_id', tool)
      if (wsErr) return { error: wsErr }
      break
    }
    case 'rename_agent': {
      const idErr = hasString(args, 'id')
      if (idErr) return { error: `rename_agent.args.${idErr}` }
      const nameErr = hasString(args, 'name')
      if (nameErr) return { error: `rename_agent.args.${nameErr}` }
      const wsErr = optionalString(args, 'workspace_id', tool)
      if (wsErr) return { error: wsErr }
      break
    }
    case 'send_to_agent': {
      const idErr = hasString(args, 'id')
      if (idErr) return { error: `send_to_agent.args.${idErr}` }
      if (typeof args.text !== 'string') return { error: 'send_to_agent.args.text must be a string' }
      const wsErr = optionalString(args, 'workspace_id', tool)
      if (wsErr) return { error: wsErr }
      break
    }
    case 'broadcast': {
      if (typeof args.text !== 'string') return { error: 'broadcast.args.text must be a string' }
      if (args.kind !== undefined && !isBroadcastKind(args.kind)) {
        return { error: `broadcast.args.kind must be one of ${BROADCAST_AGENT_KINDS.join(', ')}` }
      }
      const wsErr = optionalString(args, 'workspace_id', tool)
      if (wsErr) return { error: wsErr }
      break
    }
    case 'create_workspace': {
      const err = hasString(args, 'name')
      if (err) return { error: `create_workspace.args.${err}` }
      break
    }
    case 'get_dispatch_status': {
      if (args.workspace_id !== undefined && typeof args.workspace_id !== 'string') {
        return { error: 'get_dispatch_status.args.workspace_id must be a string' }
      }
      if (args.run_id !== undefined && typeof args.run_id !== 'string') {
        return { error: 'get_dispatch_status.args.run_id must be a string' }
      }
      break
    }
    case 'get_control_center_summary': {
      if (args.workspace_ids !== undefined && (!Array.isArray(args.workspace_ids) || args.workspace_ids.some((v) => typeof v !== 'string'))) {
        return { error: 'get_control_center_summary.args.workspace_ids must be an array of strings' }
      }
      if (args.runs_limit !== undefined && (typeof args.runs_limit !== 'number' || !Number.isInteger(args.runs_limit) || args.runs_limit < 1 || args.runs_limit > 50)) {
        return { error: 'get_control_center_summary.args.runs_limit must be an integer between 1 and 50' }
      }
      if (args.stale_threshold_ms !== undefined && (typeof args.stale_threshold_ms !== 'number' || !Number.isInteger(args.stale_threshold_ms) || args.stale_threshold_ms < 60_000 || args.stale_threshold_ms > 3_600_000)) {
        return { error: 'get_control_center_summary.args.stale_threshold_ms must be an integer between 60000 and 3600000' }
      }
      if (args.reports_limit !== undefined && (typeof args.reports_limit !== 'number' || !Number.isInteger(args.reports_limit) || args.reports_limit < 1 || args.reports_limit > 20)) {
        return { error: 'get_control_center_summary.args.reports_limit must be an integer between 1 and 20' }
      }
      if (args.include_acked !== undefined && typeof args.include_acked !== 'boolean') {
        return { error: 'get_control_center_summary.args.include_acked must be a boolean' }
      }
      break
    }
    case 'acknowledge_agent': {
      const idErr = hasString(args, 'agent_id')
      if (idErr) return { error: `acknowledge_agent.args.${idErr}` }
      const wsErr = optionalString(args, 'workspace_id', tool)
      if (wsErr) return { error: wsErr }
      if (args.reason !== undefined && (typeof args.reason !== 'string' || args.reason.length > 200)) {
        return { error: 'acknowledge_agent.args.reason must be a string no longer than 200 characters' }
      }
      if (args.by !== undefined && (typeof args.by !== 'string' || args.by.trim().length === 0 || args.by.length > 32)) {
        return { error: 'acknowledge_agent.args.by must be a non-empty string no longer than 32 characters' }
      }
      break
    }
    case 'list_workspace_reports': {
      const wsErr = hasString(args, 'workspace_id')
      if (wsErr) return { error: `list_workspace_reports.args.${wsErr}` }
      if (args.reports_limit !== undefined && (typeof args.reports_limit !== 'number' || !Number.isInteger(args.reports_limit) || args.reports_limit < 1 || args.reports_limit > 50)) {
        return { error: 'list_workspace_reports.args.reports_limit must be an integer between 1 and 50' }
      }
      if (args.unread_only !== undefined && typeof args.unread_only !== 'boolean') {
        return { error: 'list_workspace_reports.args.unread_only must be a boolean' }
      }
      break
    }
    case 'summarize_portfolio': {
      if (args.workspaceFilter !== undefined && (typeof args.workspaceFilter !== 'string' || args.workspaceFilter.trim().length === 0)) {
        return { error: 'summarize_portfolio.args.workspaceFilter must be a non-empty string when provided' }
      }
      if (args.actionableOnly !== undefined && typeof args.actionableOnly !== 'boolean') {
        return { error: 'summarize_portfolio.args.actionableOnly must be a boolean' }
      }
      break
    }
    case 'list_agents':
    case 'list_workspaces':
      break
  }
  return { tool: tool as ToolName, args }
}

export function parseActionBlockJson(block: string): ActionBlock | { error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(block)
  } catch (e) {
    return { error: `invalid aw_action JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }
  if (!isRecord(parsed)) return { error: 'aw_action JSON must be an object' }
  if (parsed.id !== undefined && (typeof parsed.id !== 'string' || parsed.id.trim().length === 0)) {
    return { error: 'action block field "id" must be a non-empty string when provided' }
  }
  const valid = validateToolCall(parsed.tool, parsed.args)
  if ('error' in valid) return valid
  return parsed.id === undefined ? valid : { ...valid, id: parsed.id.trim() }
}

export function selectBroadcastTargets<T extends Pick<Agent, 'workspaceId' | 'status' | 'kind'>>(
  agents: T[],
  workspaceId: string,
  kind?: AgentKind,
): T[] {
  return agents.filter((agent) =>
    agent.workspaceId === workspaceId &&
    agent.status === 'running' &&
    (kind === undefined || agent.kind === kind),
  )
}

export function resolveDirectAgentTarget<T extends Pick<Agent, 'id' | 'workspaceId'>>(input: {
  agents: T[]
  id: string
  activeWorkspaceId?: string
  explicitWorkspaceId?: string
}): { ok: true; agent: T; targetWorkspaceId: string; explicit: boolean } | { error: string } {
  const agent = input.agents.find((a) => a.id === input.id)
  if (!agent) return { error: `unknown agent id: ${input.id}` }

  if (input.explicitWorkspaceId) {
    if (agent.workspaceId !== input.explicitWorkspaceId) {
      return { error: `agent ${input.id} belongs to workspace ${agent.workspaceId}, not ${input.explicitWorkspaceId}` }
    }
    return { ok: true, agent, targetWorkspaceId: agent.workspaceId, explicit: true }
  }

  if (!input.activeWorkspaceId) return { error: 'no active workspace' }
  if (agent.workspaceId !== input.activeWorkspaceId) {
    return { error: `agent ${input.id} belongs to workspace ${agent.workspaceId}; supply workspace_id to target it explicitly` }
  }
  return { ok: true, agent, targetWorkspaceId: agent.workspaceId, explicit: false }
}
