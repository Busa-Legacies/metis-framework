import type { LayoutNode, SplitDir } from './types'

let _id = 0
const nid = (p: string) => `${p}_${(++_id).toString(36)}_${Math.random().toString(36).slice(2, 6)}`

export function newLeaf(agentId: string | null = null): LayoutNode {
  return { kind: 'leaf', id: nid('lf'), agentId }
}

export function singleLeafLayout(): LayoutNode {
  return newLeaf(null)
}

/** All leaves in tree order. */
export function leaves(node: LayoutNode): Extract<LayoutNode, { kind: 'leaf' }>[] {
  if (node.kind === 'leaf') return [node]
  return node.children.flatMap(leaves)
}

export function findLeaf(node: LayoutNode, id: string): Extract<LayoutNode, { kind: 'leaf' }> | null {
  if (node.kind === 'leaf') return node.id === id ? node : null
  for (const c of node.children) {
    const f = findLeaf(c, id)
    if (f) return f
  }
  return null
}

/** Assign or unassign an agent to a leaf. Clears url when assigning agent. */
export function assignAgent(root: LayoutNode, leafId: string, agentId: string | null): LayoutNode {
  return mapTree(root, (n) => (n.kind === 'leaf' && n.id === leafId ? { ...n, agentId, url: agentId ? null : n.url, title: agentId ? null : n.title } : n))
}

/** Set a leaf to display a browser preview at the given URL. Clears agentId. */
export function assignUrl(root: LayoutNode, leafId: string, url: string | null, title?: string | null): LayoutNode {
  return mapTree(root, (n) => (n.kind === 'leaf' && n.id === leafId ? { ...n, url, title: title ?? n.title ?? null, agentId: url ? null : n.agentId } : n))
}

/** Swap the contents (agentId + url + title) of two leaves. */
export function swapLeaves(root: LayoutNode, aId: string, bId: string): LayoutNode {
  if (aId === bId) return root
  const a = findLeaf(root, aId)
  const b = findLeaf(root, bId)
  if (!a || !b) return root
  return mapTree(root, (n) => {
    if (n.kind !== 'leaf') return n
    if (n.id === aId) return { ...n, agentId: b.agentId, url: b.url ?? null, title: b.title ?? null }
    if (n.id === bId) return { ...n, agentId: a.agentId, url: a.url ?? null, title: a.title ?? null }
    return n
  })
}

/** Detach an agent from any leaf that holds it. Used when agent dies/closed. */
export function detachAgent(root: LayoutNode, agentId: string): LayoutNode {
  return mapTree(root, (n) => (n.kind === 'leaf' && n.agentId === agentId ? { ...n, agentId: null } : n))
}

/** Auto-place an agent into the first empty leaf, or into the active leaf, or split if needed. */
export function placeAgent(root: LayoutNode, agentId: string, preferredLeafId?: string): LayoutNode {
  // 1. already visible; placement should focus elsewhere rather than duplicate
  if (leaves(root).some((l) => l.agentId === agentId)) return root
  // 2. preferred leaf if empty
  if (preferredLeafId) {
    const lf = findLeaf(root, preferredLeafId)
    if (lf && !lf.agentId) return assignAgent(root, preferredLeafId, agentId)
  }
  // 3. first empty leaf
  const empty = leaves(root).find((l) => !l.agentId)
  if (empty) return assignAgent(root, empty.id, agentId)
  // 4. otherwise replace the agent in the preferred leaf (or first leaf)
  const target = preferredLeafId && findLeaf(root, preferredLeafId) ? preferredLeafId : leaves(root)[0].id
  return assignAgent(root, target, agentId)
}

export function placeOrFocusAgent(root: LayoutNode, agentId: string, preferredLeafId?: string): { root: LayoutNode; leafId: string | null; placed: boolean } {
  const existing = leaves(root).find((leaf) => leaf.agentId === agentId)
  if (existing) return { root, leafId: existing.id, placed: false }

  const placedRoot = placeAgent(root, agentId, preferredLeafId)
  const target = leaves(placedRoot).find((leaf) => leaf.agentId === agentId)
  return { root: placedRoot, leafId: target?.id ?? null, placed: true }
}

/** Build a preset N-way layout: 1, 2 side-by-side, 3 (1 left + 2 stacked), 4 = 2x2, 5+ = N columns. */
export function buildPresetLayout(n: number): LayoutNode {
  if (n <= 1) return newLeaf(null)
  const split = (dir: SplitDir, children: LayoutNode[]): LayoutNode => ({
    kind: 'split',
    id: nid('sp'),
    dir,
    sizes: Array(children.length).fill(100 / children.length),
    children,
  })
  if (n === 2) return split('horizontal', [newLeaf(), newLeaf()])
  if (n === 3) return split('horizontal', [newLeaf(), split('vertical', [newLeaf(), newLeaf()])])
  if (n === 4) return split('vertical', [
    split('horizontal', [newLeaf(), newLeaf()]),
    split('horizontal', [newLeaf(), newLeaf()]),
  ])
  if (n === 5) return split('vertical', [
    split('horizontal', [newLeaf(), newLeaf(), newLeaf()]),
    split('horizontal', [newLeaf(), newLeaf()]),
  ])
  if (n === 6) return split('vertical', [
    split('horizontal', [newLeaf(), newLeaf(), newLeaf()]),
    split('horizontal', [newLeaf(), newLeaf(), newLeaf()]),
  ])
  if (n === 7) return split('vertical', [
    split('horizontal', [newLeaf(), newLeaf(), newLeaf(), newLeaf()]),
    split('horizontal', [newLeaf(), newLeaf(), newLeaf()]),
  ])
  if (n === 8) return split('vertical', [
    split('horizontal', [newLeaf(), newLeaf(), newLeaf(), newLeaf()]),
    split('horizontal', [newLeaf(), newLeaf(), newLeaf(), newLeaf()]),
  ])
  if (n === 9) return split('vertical', [
    split('horizontal', [newLeaf(), newLeaf(), newLeaf()]),
    split('horizontal', [newLeaf(), newLeaf(), newLeaf()]),
    split('horizontal', [newLeaf(), newLeaf(), newLeaf()]),
  ])
  if (n === 10) return split('vertical', [
    split('horizontal', [newLeaf(), newLeaf(), newLeaf(), newLeaf(), newLeaf()]),
    split('horizontal', [newLeaf(), newLeaf(), newLeaf(), newLeaf(), newLeaf()]),
  ])
  if (n === 11 || n === 12) return split('vertical', [
    split('horizontal', [newLeaf(), newLeaf(), newLeaf(), newLeaf()]),
    split('horizontal', [newLeaf(), newLeaf(), newLeaf(), newLeaf()]),
    split('horizontal', Array.from({ length: n - 8 }, () => newLeaf())),
  ])
  if (n <= 16) {
    // 4×4 grid for 13–16
    const rows = Math.ceil(n / 4)
    const remainder = n - (rows - 1) * 4
    const rowChildren: LayoutNode[] = []
    for (let r = 0; r < rows - 1; r++) {
      rowChildren.push(split('horizontal', [newLeaf(), newLeaf(), newLeaf(), newLeaf()]))
    }
    rowChildren.push(split('horizontal', Array.from({ length: remainder }, () => newLeaf())))
    return split('vertical', rowChildren)
  }
  // 17+: 6 cols × ceil(n/6) rows
  const cols = 6
  const rows = Math.ceil(n / cols)
  const remainder = n - (rows - 1) * cols
  const rowChildren: LayoutNode[] = []
  for (let r = 0; r < rows - 1; r++) {
    rowChildren.push(split('horizontal', Array.from({ length: cols }, () => newLeaf())))
  }
  rowChildren.push(split('horizontal', Array.from({ length: remainder }, () => newLeaf())))
  return split('vertical', rowChildren)
}

/** Apply a preset N-pane layout, preserving agent assignments where possible. */
export function applyPreset(root: LayoutNode, n: number): LayoutNode {
  const lvs = leaves(root)
  const liveIds = lvs.filter((l) => l.agentId).map((l) => l.agentId!)
  const preset = buildPresetLayout(Math.max(1, n))
  const presetLvs = leaves(preset)
  let next: LayoutNode = preset
  for (let i = 0; i < liveIds.length && i < presetLvs.length; i++) {
    next = assignAgent(next, presetLvs[i].id, liveIds[i])
  }
  return next
}

/**
 * Make sure the layout has a slot for every live agent.
 * - Detaches dead agents.
 * - Fills empty leaves with unassigned agents (in input order).
 * - If still not enough leaves, rebuilds the layout as a preset for the total count
 *   (preserving existing assignments by re-applying them in order).
 */
export function ensureLayoutForAgents(root: LayoutNode, agentIds: string[]): LayoutNode {
  let next = root
  // 1. Detach dead agents
  const live = new Set(agentIds)
  for (const lf of leaves(next)) {
    if (lf.agentId && !live.has(lf.agentId)) next = assignAgent(next, lf.id, null)
  }
  // 2. Order: existing-assigned agents first (in their leaf order), then new ones (in input order)
  const assignedInOrder: string[] = []
  for (const lf of leaves(next)) if (lf.agentId) assignedInOrder.push(lf.agentId)
  const remaining = agentIds.filter((id) => !assignedInOrder.includes(id))
  const finalOrder = [...assignedInOrder, ...remaining]

  // 3. If we have enough leaves, fill empties with `remaining`
  const totalLeaves = leaves(next).length
  if (totalLeaves >= finalOrder.length) {
    for (const id of remaining) {
      const empty = leaves(next).find((l) => !l.agentId)
      if (!empty) break
      next = assignAgent(next, empty.id, id)
    }
    return next
  }

  // 4. Not enough leaves — rebuild as preset and assign in finalOrder
  const preset = buildPresetLayout(finalOrder.length)
  const presetLvs = leaves(preset)
  let final = preset
  for (let i = 0; i < finalOrder.length && i < presetLvs.length; i++) {
    final = assignAgent(final, presetLvs[i].id, finalOrder[i])
  }
  return final
}

/** Split a leaf in given direction; new leaf becomes empty (right/bottom). */
export function splitLeaf(root: LayoutNode, leafId: string, dir: SplitDir): LayoutNode {
  return mapTree(root, (n) => {
    if (n.kind === 'leaf' && n.id === leafId) {
      const a = { ...n, id: nid('lf') }
      const b = newLeaf(null)
      const split: LayoutNode = { kind: 'split', id: nid('sp'), dir, sizes: [50, 50], children: [a, b] }
      return split
    }
    return n
  })
}

/** Close a leaf; if its parent split is left with one child, collapse it. */
export function closeLeaf(root: LayoutNode, leafId: string): LayoutNode {
  function rec(n: LayoutNode): LayoutNode | null {
    if (n.kind === 'leaf') return n.id === leafId ? null : n
    const next = n.children.map(rec).filter((c): c is LayoutNode => c !== null)
    if (next.length === 0) return null
    if (next.length === 1) return next[0]
    // rebalance sizes if count changed
    const sizes = next.length === n.children.length
      ? n.sizes
      : Array(next.length).fill(100 / next.length)
    return { ...n, children: next, sizes }
  }
  const out = rec(root)
  return out ?? newLeaf(null)
}

/** Update sizes after a resize handle drag. */
export function updateSizes(root: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  return mapTree(root, (n) => (n.kind === 'split' && n.id === splitId ? { ...n, sizes } : n))
}

function mapTree(node: LayoutNode, fn: (n: LayoutNode) => LayoutNode): LayoutNode {
  const out = fn(node)
  if (out.kind === 'split') {
    return { ...out, children: out.children.map((c) => mapTree(c, fn)) }
  }
  return out
}
