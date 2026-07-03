/**
 * Pure run-complete detection for the round-trip verify loop (#258).
 *
 * The sidecar stamps `outputBytes` on every PTY byte; "the agent's run is
 * complete" is detected as: output flowed after the send, then went quiet for
 * `quietMs`. Pure state machine — the polling/React side lives in
 * `use-agent-run-watcher.ts`; this module has no DOM, no timers, no I/O.
 * (Generated via smith lane against the #258 plan spec; test 3 corrected.)
 */

export type RunPhase = 'idle' | 'awaiting-output' | 'active' | 'complete' | 'gave-up'

export interface WatchState {
  phase: RunPhase
  sentAt: number
  lastSeenBytes: number
  lastActivityAt: number
}

export interface WatchOptions {
  quietMs: number
  timeoutMs: number
}

export const DEFAULT_WATCH_OPTIONS: WatchOptions = {
  quietMs: 10_000,
  timeoutMs: 15 * 60_000,
}

/** Begin a watch at send time, baselined on the bytes already emitted. */
export function startWatch(now: number, currentBytes: number): WatchState {
  return {
    phase: 'awaiting-output',
    sentAt: now,
    lastSeenBytes: currentBytes,
    lastActivityAt: now,
  }
}

/**
 * Advance the watch given fresh agent metadata. Pure: returns a new state.
 * Terminal phases (`complete`/`gave-up`/`idle`) are returned unchanged.
 */
export function stepWatch(
  state: WatchState,
  meta: { status: string; outputBytes?: number } | undefined,
  now: number,
  opts: WatchOptions,
): WatchState {
  if (state.phase === 'complete' || state.phase === 'gave-up' || state.phase === 'idle') {
    return state
  }
  if (meta === undefined || meta.status === 'exited') {
    return { ...state, phase: 'gave-up' }
  }
  if (now - state.sentAt > opts.timeoutMs) {
    return { ...state, phase: 'gave-up' }
  }
  const bytes = meta.outputBytes ?? 0
  if (bytes > state.lastSeenBytes) {
    return { ...state, lastSeenBytes: bytes, lastActivityAt: now, phase: 'active' }
  }
  if (state.phase === 'active' && now - state.lastActivityAt >= opts.quietMs) {
    return { ...state, phase: 'complete' }
  }
  return state
}
