export interface WorkbenchGatewayMetadata {
  surface: 'metis-command'
  activeWorkspaceId?: string
  activeWorkspaceName?: string
  activeWorkspaceCwd?: string
  visiblePaneSummary?: string
}

export function buildWorkbenchSessionKey(workspaceId?: string | null): string {
  const normalized = typeof workspaceId === 'string' ? workspaceId.trim() : ''
  return `workbench:${normalized || 'global'}`
}

export function isReservedNonWorkbenchSessionKey(sessionKey: string): boolean {
  return sessionKey === 'main' || sessionKey === 'default' || sessionKey === 'telegram' || sessionKey.startsWith('telegram:')
}
