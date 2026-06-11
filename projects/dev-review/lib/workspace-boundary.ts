import path from 'node:path'

function expandHomeWith(homeDir: string, value: string): string {
  if (value === '~') return homeDir
  if (value.startsWith('~/')) return path.join(homeDir, value.slice(2))
  return value
}

export function isPathWithinRoot(candidate: string, root: string): boolean {
  const resolvedCandidate = path.resolve(candidate)
  const resolvedRoot = path.resolve(root)
  const relative = path.relative(resolvedRoot, resolvedCandidate)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

export function validateWorkspaceCwd(input: {
  requestedCwd?: string
  workspaceCwd: string
  pinnedRoots?: string[]
  homeDir: string
}): { ok: true; cwd: string } | { ok: false; error: string } {
  const raw = input.requestedCwd?.trim() || input.workspaceCwd
  const cwd = path.resolve(expandHomeWith(input.homeDir, raw))
  const roots = [
    path.resolve(expandHomeWith(input.homeDir, input.workspaceCwd)),
    ...(input.pinnedRoots ?? []).map((r) => path.resolve(expandHomeWith(input.homeDir, r))),
  ]

  if (roots.some((root) => isPathWithinRoot(cwd, root))) return { ok: true, cwd }

  return {
    ok: false,
    error: `cwd outside workspace boundary: ${cwd}`,
  }
}
