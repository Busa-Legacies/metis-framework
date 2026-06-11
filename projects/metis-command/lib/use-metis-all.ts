'use client'

import { useCallback, useEffect, useState } from 'react'
import { metisApi, type MetisResult } from './metis-api'
import type { MetisAll } from './metis-api-types'

/**
 * Shared live-/api/all hook for Control Center surfaces (Overview, Work Graph,
 * Ops, Usage, Personal, …). All mode panes stay mounted in the shell (hidden,
 * not unmounted), so a naive per-hook poller meant N modes × one /api/all every
 * 15s each — a thundering herd on first paint (the "Native stuck on loading"
 * defect: 6 concurrent cold requests through the dev proxy) and 6× steady-state
 * load. This version backs every hook instance onto ONE module-level store with
 * a single in-flight fetch and a single interval; subscribers re-render on each
 * result. Manual `reload`/`hardReload` act on the shared store, so a refresh in
 * one mode freshens all of them.
 */

type Listener = () => void

const store: {
  res: MetisResult<MetisAll> | null
  loading: boolean
  listeners: Set<Listener>
  timer: ReturnType<typeof setInterval> | null
  inflight: Promise<void> | null
  intervalMs: number
} = { res: null, loading: false, listeners: new Set(), timer: null, inflight: null, intervalMs: 15000 }

function notify() {
  store.listeners.forEach((l) => l())
}

function fetchShared(): Promise<void> {
  if (store.inflight) return store.inflight // collapse concurrent callers into one request
  store.loading = true
  notify()
  store.inflight = metisApi
    .all()
    .then((r) => {
      store.res = r
    })
    .finally(() => {
      store.inflight = null
      store.loading = false
      notify()
    })
  return store.inflight
}

async function hardReloadShared(): Promise<void> {
  store.loading = true
  notify()
  await metisApi.invalidateCache()
  // bypass in-flight collapsing: this must be a genuinely fresh fetch
  const r = await metisApi.all()
  store.res = r
  store.loading = false
  notify()
}

function subscribe(l: Listener): () => void {
  store.listeners.add(l)
  if (store.listeners.size === 1) {
    // first subscriber: start the single poller
    fetchShared()
    store.timer = setInterval(fetchShared, store.intervalMs)
  }
  return () => {
    store.listeners.delete(l)
    if (store.listeners.size === 0 && store.timer) {
      clearInterval(store.timer)
      store.timer = null
    }
  }
}

export function useMetisAll(intervalMs = 15000) {
  // re-render trigger: bump a counter whenever the shared store updates
  const [, setTick] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    store.intervalMs = intervalMs
    const unsub = subscribe(() => setTick((t) => t + 1))
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      unsub()
      clearInterval(tick)
    }
  }, [intervalMs])

  const reload = useCallback(async () => {
    await fetchShared()
    setNow(Date.now())
  }, [])

  const hardReload = useCallback(async () => {
    await hardReloadShared()
    setNow(Date.now())
  }, [])

  const res = store.res
  return { res, data: res?.ok ? res.data : null, loading: store.loading, now, reload, hardReload }
}
