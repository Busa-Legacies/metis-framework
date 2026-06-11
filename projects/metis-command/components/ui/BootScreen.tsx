'use client'

import { useEffect, useLayoutEffect, useState } from 'react'

// Layout effect on the client (runs before paint, so an already-shown reload can
// hide the cover with no flash); plain effect on the server to avoid the SSR warning.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

/**
 * Métis boot screen — the web/mobile first-paint cover, mirroring the Electron
 * splash (electron/splash.html) so the Control Center "wakes up" the same way whether
 * it's launched as a desktop app or hit over the browser/Tailscale. The mark's
 * nodes pop in sequence, the midnight links trace between them, then the wordmark
 * + amber pulse + mission-control readout settle in. It covers the shell once on
 * a cold load, then fades out and unmounts.
 *
 * Shown once per tab session (sessionStorage) so route changes / HMR don't replay
 * it. Styles + timing live in globals.css (.metis-boot*).
 */
const SESSION_KEY = 'metis.boot.shown'
const HOLD_MS = 2600 // let the readout reach "ready" before we start leaving
const FADE_MS = 500 // matches .metis-boot transition

export default function BootScreen() {
  // Start VISIBLE so the cover is the very first paint on a cold load — the app
  // shell never flashes in front of it. SSR renders 'visible' too, so hydration
  // matches. A layout effect then either hides it instantly (already shown this
  // tab session — runs before paint, no flash) or schedules the fade-out.
  const [phase, setPhase] = useState<'visible' | 'leaving' | 'gone'>('visible')

  useIsoLayoutEffect(() => {
    let shown = false
    try {
      shown = window.sessionStorage.getItem(SESSION_KEY) === '1'
    } catch {
      /* sessionStorage unavailable — show it */
    }
    if (shown) {
      setPhase('gone')
      return
    }

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const hold = reduce ? 700 : HOLD_MS

    const leave = window.setTimeout(() => setPhase('leaving'), hold)
    const done = window.setTimeout(() => {
      setPhase('gone')
      try {
        window.sessionStorage.setItem(SESSION_KEY, '1')
      } catch {
        /* ignore */
      }
    }, hold + FADE_MS)

    return () => {
      window.clearTimeout(leave)
      window.clearTimeout(done)
    }
  }, [])

  if (phase === 'gone') return null

  return (
    <div className={`metis-boot${phase === 'leaving' ? ' is-leaving' : ''}`} role="status" aria-label="Métis is starting up">
      <div className="metis-boot__wrap">
        <svg className="metis-boot__mark" viewBox="0 0 96 96" fill="none" aria-hidden="true">
          <polyline className="metis-boot__edge" points="22,78 28,20 48,54 68,20 74,78" />
          <circle className="metis-boot__node n1" cx="22" cy="78" r="2.8" fill="#34d3ff" />
          <circle className="metis-boot__node n2" cx="28" cy="20" r="2.8" fill="#34d3ff" />
          <circle className="metis-boot__node n3" cx="48" cy="54" r="3.8" fill="#f59e0b" />
          <circle className="metis-boot__node n4" cx="68" cy="20" r="2.8" fill="#34d3ff" />
          <circle className="metis-boot__node n5" cx="74" cy="78" r="2.8" fill="#34d3ff" />
        </svg>
        <div>
          <div className="metis-boot__word">Métis</div>
          <div className="metis-boot__sub">multi-agent workspace</div>
        </div>
        <div className="metis-boot__bar">
          <i />
        </div>
        <div className="metis-boot__readout">
          <p>
            <span className="arrow">&rsaquo;</span> initializing kernel
          </p>
          <p>
            <span className="arrow">&rsaquo;</span> mounting lanes
            <span className="metis-boot__lanes">
              <i />
              <i />
              <i />
              <i />
            </span>
          </p>
          <p>
            <span className="arrow">&rsaquo;</span> aurora <span className="ok">online</span>
          </p>
          <p>
            <span className="arrow">&rsaquo;</span> <span className="go">ready</span>
          </p>
        </div>
      </div>
    </div>
  )
}
