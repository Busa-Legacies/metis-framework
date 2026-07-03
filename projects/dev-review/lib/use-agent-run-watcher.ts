'use client'

/**
 * Round-trip verify trigger (#258): after annotations are sent to the agent,
 * poll the sidecar's agent metadata (lastOutput byte counter) and detect
 * run-complete as "output flowed, then went quiet for QUIET_MS". On complete,
 * bump verifyRequestId — PreviewPane reloads the proxied preview and the load
 * handler re-verifies every pin against the fresh document.
 *
 * Mounted once in ReviewShell (shell level, so mobile tab switches don't kill
 * the watch). The state machine itself is pure (lib/agent-run-watcher.ts).
 */
import { useEffect, useRef } from 'react'
import { useReviewStore } from './review-store'
import { ptyApi } from './pty-client'
import { DEFAULT_WATCH_OPTIONS, startWatch, stepWatch, type WatchState } from './agent-run-watcher'

const POLL_MS = 3000

export function useAgentRunWatcher() {
  const awaitingAgent = useReviewStore((s) => s.awaitingAgent)
  const agentId = useReviewStore((s) => s.agentId)
  const watchRef = useRef<WatchState | null>(null)

  useEffect(() => {
    if (!awaitingAgent || !agentId) {
      watchRef.current = null
      return
    }
    let cancelled = false

    async function agentMeta() {
      const { agents } = await ptyApi.listAgents()
      return agents.find((a) => a.id === agentId)
    }

    async function arm() {
      const meta = await agentMeta().catch(() => undefined)
      if (cancelled) return
      watchRef.current = startWatch(Date.now(), meta?.outputBytes ?? 0)
    }

    async function tick() {
      if (cancelled || !watchRef.current) return
      const meta = await agentMeta().catch(() => undefined)
      if (cancelled || !watchRef.current) return
      const next = stepWatch(watchRef.current, meta, Date.now(), DEFAULT_WATCH_OPTIONS)
      watchRef.current = next
      if (next.phase === 'complete') {
        useReviewStore.getState().setAwaitingAgent(false)
        useReviewStore.getState().requestVerify()
      } else if (next.phase === 'gave-up') {
        useReviewStore.getState().setAwaitingAgent(false)
      }
    }

    void arm()
    const timer = setInterval(() => { void tick() }, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [awaitingAgent, agentId])
}
