import type { Workspace } from './types'

export function resolveWorkspaceSelector(workspaces: Workspace[], selector: string): { workspaceId: string } | { error: string } {
  const trimmed = selector.trim()
  const byId = workspaces.find((w) => w.id === trimmed)
  if (byId) return { workspaceId: byId.id }
  const nameMatches = workspaces.filter((w) => w.name.toLowerCase() === trimmed.toLowerCase())
  if (nameMatches.length === 1) return { workspaceId: nameMatches[0].id }
  if (nameMatches.length > 1) {
    return { error: `ambiguous workspace name "${trimmed}"; choose one workspace_id: ${nameMatches.map((w) => `${w.id} (${w.name})`).join(', ')}` }
  }
  return { error: `unknown workspace id/name: ${trimmed}` }
}
