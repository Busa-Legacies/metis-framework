'use client'

import { MetisMark } from './MetisMark'

/**
 * Shared branded loading primitive — the Métis constellation with its nodes
 * twinkling in sequence, optionally with a label. Use anywhere a spinner would
 * go (panels, modes, async boundaries) so loading states read as "Métis is
 * thinking" rather than a generic spinner.
 *
 *   <MetisLoader />                       // bare mark, centered
 *   <MetisLoader label="loading agents…" inline />
 */
export function MetisLoader({
  size = 40,
  label,
  inline = false,
  className = '',
}: {
  size?: number
  label?: string
  inline?: boolean
  className?: string
}) {
  if (inline) {
    return (
      <span className={`inline-flex items-center gap-2 text-[var(--muted)] ${className}`}>
        <MetisMark size={size} animated />
        {label && <span className="animate-pulse">{label}</span>}
      </span>
    )
  }
  return (
    <div className={`flex flex-col items-center justify-center gap-3 text-[var(--muted)] ${className}`}>
      <MetisMark size={size} animated />
      {label && <span className="text-xs tracking-wide animate-pulse">{label}</span>}
    </div>
  )
}
