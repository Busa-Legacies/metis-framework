'use client'

import { useEffect, useState } from 'react'
import type { AuthStatus } from './auth-status'

/**
 * Client hook for CLI auth status (`/api/auth/status`). Type-only import of
 * AuthStatus keeps the `server-only` lib out of the client bundle. Fetches once
 * on mount; null until loaded.
 */
export function useAuthStatus(): AuthStatus | null {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  useEffect(() => {
    let alive = true
    fetch('/api/auth/status', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => { if (alive && s) setStatus(s) })
      .catch(() => {})
    return () => { alive = false }
  }, [])
  return status
}
