'use client'

/**
 * Métis OS brand mark — a constellation that traces an "M": the multi-agent
 * network (forge · scout · shield · echo) lit up as nodes + links. Cyan nodes
 * and edges with an amber apex (the valley node) for the secondary-highlight pop.
 * Brand-consistent across Control Center and dashboard contexts; pass `animated` for the
 * idle twinkle used by loaders/splash.
 *
 * Geometry is shared verbatim with the Electron splash (electron/splash.html) and
 * the dashboard boot overlays so the mark is pixel-identical everywhere.
 */
interface MetisMarkProps {
  size?: number
  className?: string
  animated?: boolean
  title?: string
}

// M-tracing constellation on a 96×96 grid: base + peaks + central valley apex.
// Straight geometry (matches the mono wordmark); shared verbatim with the
// splash + dashboard boot overlays.
const NODES: Array<[number, number, 'cyan' | 'amber', number]> = [
  [22, 78, 'cyan', 0],
  [28, 20, 'cyan', 0.15],
  [48, 54, 'amber', 0.45], // apex / highlight
  [68, 20, 'cyan', 0.3],
  [74, 78, 'cyan', 0.6],
]

export function MetisMark({ size = 28, className = '', animated = false, title = 'Métis' }: MetisMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 96 96"
      fill="none"
      role="img"
      aria-label={title}
      className={className}
    >
      {/* Clean flat strokes — no glow/blur (the blurred halo read as an "outline"
          tube around the midnight links). Nodes carry the life via twinkle. */}
      <polyline
        points="22,78 28,20 48,54 68,20 74,78"
        fill="none"
        stroke="#21456b"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {NODES.map(([cx, cy, tone, delay], i) => (
        <circle
          key={i}
          cx={cx}
          cy={cy}
          r={tone === 'amber' ? 3.8 : 2.8}
          fill={tone === 'amber' ? '#f59e0b' : '#34d3ff'}
          className={animated ? 'metis-node' : undefined}
          style={animated ? { animationDelay: `${delay}s` } : undefined}
        />
      ))}
    </svg>
  )
}
