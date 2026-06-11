import { create } from 'zustand'
import { nanoid } from 'nanoid'

/** One pinned review comment, anchored to an element in the page under review. */
export interface Annotation {
  id: string
  /** CSS selector that matched exactly one element at capture time. */
  selector: string
  comment: string
  /** Bounding rect at capture time (page coords) — visual ground truth if the selector orphans. */
  rect: { x: number; y: number; width: number; height: number }
  /** Key computed styles captured at pin time. */
  styles: Record<string, string>
  url: string
  ts: number
  status: 'open' | 'resolved' | 'orphaned' | 'changed'
  severity: 'note' | 'issue' | 'blocker'
  /** Styles captured during the last verify pass — present when status is 'changed'. */
  verifiedStyles?: Record<string, string>
}

interface ReviewState {
  /** URL of the app under review (iframe src). */
  url: string
  setUrl: (url: string) => void
  /** Element-picker armed — clicks in the preview create pins instead of acting. */
  picking: boolean
  setPicking: (on: boolean) => void
  annotations: Annotation[]
  addAnnotation: (a: Omit<Annotation, 'id' | 'ts' | 'status'>) => Annotation
  updateAnnotation: (id: string, patch: Partial<Annotation>) => void
  removeAnnotation: (id: string) => void
  /** Active agent terminal (PTY id), if one is attached. */
  agentId: string | null
  setAgentId: (id: string | null) => void
  workspaceId: string | null
  setWorkspaceId: (id: string | null) => void
  /** Disk path of the persisted session file (agent-readable artifact). */
  sessionPath: string | null
  hydrate: (url: string) => Promise<void>
  /** Re-run selectors against the live iframe document, mark changed/unchanged. */
  verifyAll: (doc: Document) => void
}

export const useReviewStore = create<ReviewState>((set) => ({
  url: 'http://localhost:8080',
  setUrl: (url) => set({ url }),
  picking: false,
  setPicking: (picking) => set({ picking }),
  annotations: [],
  addAnnotation: (a) => {
    const ann: Annotation = { ...a, id: nanoid(8), ts: Date.now(), status: 'open' }
    set((s) => ({ annotations: [...s.annotations, ann] }))
    return ann
  },
  updateAnnotation: (id, patch) =>
    set((s) => ({ annotations: s.annotations.map((x) => (x.id === id ? { ...x, ...patch } : x)) })),
  removeAnnotation: (id) => set((s) => ({ annotations: s.annotations.filter((x) => x.id !== id) })),
  agentId: null,
  setAgentId: (agentId) => set({ agentId }),
  workspaceId: null,
  setWorkspaceId: (workspaceId) => set({ workspaceId }),
  sessionPath: null,
  hydrate: async (url) => {
    try {
      const res = await fetch(`/api/reviews?url=${encodeURIComponent(url)}`)
      const data = await res.json()
      set({ sessionPath: data.path ?? null, annotations: data.session?.annotations ?? [] })
    } catch {
      set({ sessionPath: null, annotations: [] })
    }
  },
  verifyAll: (doc) => {
    const { annotations } = useReviewStore.getState()
    const STYLE_KEYS = ['color', 'background-color', 'font-size', 'font-family', 'padding', 'margin', 'display', 'position'] as const
    annotations.forEach((a) => {
      if (a.status === 'resolved') return
      let els: NodeListOf<Element>
      try { els = doc.querySelectorAll(a.selector) } catch { return }
      if (els.length !== 1) {
        if (a.status !== 'orphaned') useReviewStore.getState().updateAnnotation(a.id, { status: 'orphaned' })
        return
      }
      const el = els[0] as HTMLElement
      const cs = doc.defaultView?.getComputedStyle(el)
      if (!cs) return
      const current: Record<string, string> = {}
      for (const k of STYLE_KEYS) current[k] = cs.getPropertyValue(k)
      const changed = (Object.keys(a.styles) as string[]).some((k) => a.styles[k] !== current[k]) ||
        (Object.keys(current) as string[]).some((k) => current[k] !== (a.styles[k] ?? ''))
      useReviewStore.getState().updateAnnotation(a.id, {
        status: changed ? 'changed' : 'open',
        verifiedStyles: changed ? current : undefined,
      })
    })
  },
}))

// Testability seam: e2e drives the store directly (e.g. attach a shell agent
// instead of spending claude quota). Dev/test only — stripped by NODE_ENV.
if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
  ;(window as unknown as Record<string, unknown>).__reviewStore = useReviewStore
}

// Debounced autosave — any annotation change persists the session to disk.
let saveTimer: ReturnType<typeof setTimeout> | null = null
useReviewStore.subscribe((state, prev) => {
  if (state.annotations === prev.annotations) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    fetch('/api/reviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: state.url, annotations: state.annotations }),
    }).catch(() => { /* surfaced on next hydrate; never blocks the UI */ })
  }, 800)
})

/** Format annotations as a structured prompt block for the agent PTY. */
export function annotationsToPrompt(anns: Annotation[], url: string, sessionPath?: string | null): string {
  const actionable = anns.filter((a) => a.status === 'open' || a.status === 'changed')
  const lines = actionable.map((a, i) => {
    const verifyNote = a.status === 'changed' && a.verifiedStyles
      ? `   verify: styles changed — before: ${Object.entries(a.styles).map(([k, v]) => `${k}=${v}`).join(' ')} | after: ${Object.entries(a.verifiedStyles).map(([k, v]) => `${k}=${v}`).join(' ')}`
      : null
    return [
      `${i + 1}. [${a.severity}${a.status === 'changed' ? '/changed' : ''}] ${a.comment}`,
      `   selector: ${a.selector}`,
      `   rect: ${Math.round(a.rect.x)},${Math.round(a.rect.y)} ${Math.round(a.rect.width)}x${Math.round(a.rect.height)}`,
      Object.keys(a.styles).length
        ? `   pinned-styles: ${Object.entries(a.styles).map(([k, v]) => `${k}=${v}`).join(' ')}`
        : null,
      verifyNote,
    ].filter(Boolean).join('\n')
  })
  const changed = anns.filter((a) => a.status === 'changed').length
  const header = changed
    ? `Frontend review of ${url} — ${actionable.length} item(s) (${changed} with style changes detected):`
    : `Frontend review of ${url} — ${actionable.length} annotation(s):`
  return [
    header,
    ...lines,
    'Fix each item. The selector pinpoints the exact element; rect/pinned-styles are capture-time ground truth.',
    sessionPath ? `Full payloads: ${sessionPath}` : null,
  ].filter(Boolean).join('\n')
}
