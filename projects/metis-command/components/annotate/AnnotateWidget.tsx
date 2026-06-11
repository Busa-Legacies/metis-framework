'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import { MessageSquarePlus, Send, X, Loader2, Bot, Trash2, Camera, Paperclip, Crop } from 'lucide-react'
import { useControlCenterNav } from '@/lib/control-center-nav'
import { modeById } from '@/lib/control-center-modes'
import { ptyApi } from '@/lib/pty-client'
import type { Attachment } from '@/lib/types'
import { MetisLoader } from '../ui/MetisLoader'

/**
 * Annotate — site-wide "message Metis about this page" tool. A floating button
 * on every mode opens a chat where Ant can ask for formatting fixes or new
 * features in place; the message is sent to the existing /api/assistant brain
 * (auto mode) with page context injected — current mode + its source files —
 * so the assistant can spawn a tightly-scoped builder agent to land the change.
 * Hidden in Agents mode, where the full Assistant panel already lives.
 */

const THREAD_KEY = 'metis.annotate.thread'
const METIS_ROOT = '${METIS_HOME}'
const OPEN_EVENT = 'metis:annotate-open'

/**
 * Header entry point — replaces the per-page refresh buttons (pages poll
 * automatically + SWR backend made manual refresh redundant; Ant 2026-06-10).
 * Desktop-only: mobile keeps the thumb-zone FAB as its single entry.
 */
export function AnnotateTrigger() {
  return (
    <button
      onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))}
      data-testid="annotate-trigger"
      title="Annotate this page — ask Metis to fix or add something"
      className="hidden items-center gap-1.5 rounded-lg border border-cyan-300/30 bg-cyan-300/10 px-2.5 py-1.5 text-[13px] md:text-[11px] font-bold text-cyan-100 hover:bg-cyan-300/20 md:flex"
    >
      <MessageSquarePlus size={14} /> annotate
    </button>
  )
}

/** Mode → source files the annotation most likely targets. */
const MODE_SOURCES: Record<string, string[]> = {
  overview: ['components/overview/OverviewMode.tsx', 'components/overview/OverviewSummary.tsx', 'components/overview/cards.tsx'],
  work: ['components/work/WorkMode.tsx', 'components/inbox/InboxMode.tsx', 'components/workgraph/WorkGraphMode.tsx', 'components/tasks/TaskBoardMode.tsx'],
  'work-graph': ['components/workgraph/WorkGraphMode.tsx'],
  inbox: ['components/inbox/InboxMode.tsx'],
  tasks: ['components/tasks/TaskBoardMode.tsx'],
  agents: ['components/Workbench.tsx'],
  usage: ['components/usage/UsageMode.tsx'],
  review: ['components/review/ReviewMode.tsx'],
  ops: ['components/ops/OpsMode.tsx'],
  personal: ['components/personal/PersonalMode.tsx'],
  settings: ['components/settings/SettingsMode.tsx'],
}

interface Msg {
  id: string
  role: 'user' | 'assistant'
  content: string
  mode?: string
  toolCalls?: { name: string; result?: string }[]
  attachments?: Attachment[]
  /** Set when the brain did NOT spawn a builder — offers the deterministic path. */
  direct?: { request: string; mode: string }
}

type Rect = { x: number; y: number; width: number; height: number }

/** Native Electron capture (window.aw.capturePreview) — renders iframes, the
 *  terminal/feed canvases, everything the DOM rasteriser can't. Returns a PNG
 *  data URL, or null outside Electron / on failure. */
async function captureNative(rect: Rect): Promise<string | null> {
  const aw = (typeof window !== 'undefined' ? (window as unknown as { aw?: { capturePreview?: (r: Rect) => Promise<string | null> } }).aw : undefined)
  if (!aw?.capturePreview) return null
  try { return await aw.capturePreview(rect) } catch { return null }
}

/** Drag-to-select a region of the screen, then capture exactly that box (desktop
 *  only). Dims the screen; the dim is unmounted before the shot so it isn't in
 *  the capture. Esc / a zero-size drag cancels. */
function RegionOverlay({ onPick, onCancel }: { onPick: (r: Rect) => void; onCancel: () => void }) {
  const [start, setStart] = useState<{ x: number; y: number } | null>(null)
  const [cur, setCur] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onCancel])
  const box = start && cur ? {
    x: Math.min(start.x, cur.x), y: Math.min(start.y, cur.y),
    width: Math.abs(cur.x - start.x), height: Math.abs(cur.y - start.y),
  } : null
  return (
    <div
      data-annotate-ignore="true"
      className="fixed inset-0 z-[80] cursor-crosshair bg-black/30"
      onMouseDown={(e) => { setStart({ x: e.clientX, y: e.clientY }); setCur({ x: e.clientX, y: e.clientY }) }}
      onMouseMove={(e) => { if (start) setCur({ x: e.clientX, y: e.clientY }) }}
      onMouseUp={() => {
        if (box && box.width > 4 && box.height > 4) onPick(box)
        else onCancel()
      }}
    >
      {!start && (
        <div className="pointer-events-none absolute left-1/2 top-6 -translate-x-1/2 rounded-lg border border-cyan-300/30 bg-[#0a0d14]/90 px-3 py-1.5 text-[12px] font-semibold text-cyan-100">
          Drag to select a region · Esc to cancel
        </div>
      )}
      {box && (
        <div className="pointer-events-none absolute border-2 border-cyan-300 bg-cyan-300/10"
          style={{ left: box.x, top: box.y, width: box.width, height: box.height }} />
      )}
    </div>
  )
}

/** Downscale/compress an image data URL so phone screenshots don't ship 5MB+ bodies. */
async function downscaleImage(dataUrl: string, maxDim = 1600): Promise<string> {
  const img = new Image()
  await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('bad image')); img.src = dataUrl })
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
  if (scale >= 1 && dataUrl.length < 1_500_000) return dataUrl
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(img.width * scale))
  c.height = Math.max(1, Math.round(img.height * scale))
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
  return c.toDataURL('image/jpeg', 0.85)
}

function pageContextPreamble(modeId: string): string {
  const mode = modeById(modeId as Parameters<typeof modeById>[0])
  const sources = (MODE_SOURCES[modeId] ?? []).map((s) => `projects/metis-command/${s}`)
  return [
    `[page-annotation] Ant is annotating the live Metis Control Center UI.`,
    `Page: "${mode.label}" (mode id: ${modeId}) — ${mode.description}`,
    `Likely source files: ${sources.join(', ') || 'unknown — locate via grep'}`,
    `Repo: ${METIS_ROOT}. Design rules: docs/design-guidelines.md (§6.5 iconography, §5 type, §6 spacing).`,
    `Attached image(s), if any, are screenshots of this page's current state — read them for the exact element Ant means.`,
    `If this needs a code change (formatting fix, new feature), dispatch it with ONE`,
    `spawn_agents call — a single builder (kind codex or claude) whose initial_prompt field`,
    `carries the COMPLETE scoped fix brief: the exact files above, what to change, the`,
    `design-guidelines constraints, and "verify with npx tsc --noEmit + npm run lint, then`,
    `commit via scripts/git-lock.sh run with an explicit pathspec, before reporting done".`,
    `Never spawn first and plan to send the brief later — initial_prompt IS the delivery.`,
    `Then reply: what you dispatched and that Ant can watch it in Agents.`,
    `A reply describing steps you have not executed is a failure; never say "in-progress".`,
    `If it is a question or trivially answerable, just answer.`,
    ``,
    `Ant's annotation:`,
  ].join('\n')
}

export default function AnnotateWidget() {
  const nav = useControlCenterNav()
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [snapping, setSnapping] = useState(false)
  const [regioning, setRegioning] = useState(false)
  const [hasNative, setHasNative] = useState(false)
  const [pending, setPending] = useState<Attachment[]>([])
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(undefined)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [messages, setMessages] = useState<Msg[]>(() => {
    if (typeof window === 'undefined') return []
    try { return JSON.parse(window.localStorage.getItem(THREAD_KEY) ?? '[]') } catch { return [] }
  })
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const persist = useCallback((next: Msg[]) => {
    setMessages(next)
    try {
      // Strip image payloads before persisting — phone screenshots would blow
      // the localStorage quota; thumbnails live only for the session.
      const slim = next.slice(-40).map((m) => m.attachments?.length
        ? { ...m, attachments: m.attachments.map((a) => ({ ...a, dataUrl: '' })) }
        : m)
      window.localStorage.setItem(THREAD_KEY, JSON.stringify(slim))
    } catch {}
  }, [])

  /** Attach picked/taken photos (iOS file input offers camera + library). */
  async function addFiles(list: FileList | File[] | null) {
    if (!list || !('length' in list) || !list.length) return
    const files = Array.from(list).slice(0, 4).filter((f) => f.type.startsWith('image/'))
    const atts = await Promise.all(files.map(async (f) => {
      const raw = await new Promise<string>((res, rej) => {
        const r = new FileReader()
        r.onload = () => res(String(r.result || ''))
        r.onerror = () => rej(new Error('read failed'))
        r.readAsDataURL(f)
      }).catch(() => '')
      if (!raw.startsWith('data:image/')) return null
      const dataUrl = await downscaleImage(raw).catch(() => raw)
      return { type: 'image' as const, dataUrl, name: f.name || 'image', size: dataUrl.length }
    }))
    setPending((p) => [...p, ...atts.filter(Boolean) as Attachment[]].slice(0, 4))
  }

  // Native capture is only available in the Electron desktop shell.
  useEffect(() => { setHasNative(!!(window as unknown as { aw?: { capturePreview?: unknown } }).aw?.capturePreview) }, [])

  const attachShot = useCallback((dataUrl: string, name: string) => {
    setPending((p) => [...p, { type: 'image' as const, dataUrl, name, size: dataUrl.length }].slice(0, 4))
  }, [])

  /** One-tap screen grab of the whole page under the panel. Desktop uses Electron's
      native capturePage (faithful — renders iframes / terminals / feeds); the
      browser/mobile fallback is a DOM raster (works in insecure contexts where
      getDisplayMedia doesn't, but iframes come out blank). */
  async function snapPage() {
    if (snapping) return
    setSnapping(true)
    // Close the sheet completely for the shot — the panel covers half the page;
    // unmounting it is unambiguous. Pending state survives (widget stays mounted).
    setOpen(false)
    try {
      await new Promise((r) => setTimeout(r, 180)) // let the close paint
      let raw: string | null = await captureNative({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight })
      if (!raw) {
        const { toJpeg } = await import('html-to-image')
        raw = await toJpeg(document.body, {
          quality: 0.9,
          pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
          filter: (node) => !(node instanceof HTMLElement && node.dataset?.annotateIgnore === 'true'),
        })
      }
      const dataUrl = await downscaleImage(raw).catch(() => raw as string)
      attachShot(dataUrl, `snap-${nav.current}.jpg`)
    } catch {
      /* capture unsupported on this page — attach a photo instead */
    } finally {
      setOpen(true) // reopen with the thumbnail pending
      setSnapping(false)
    }
  }

  /** Enter region-select mode (desktop only): close the panel so it isn't in shot,
      then show the drag overlay. */
  function startRegion() {
    if (!hasNative) return
    setOpen(false)
    setTimeout(() => setRegioning(true), 160)
  }

  /** After the user boxes a region: unmount the overlay, let it clear, then
      capture exactly that rect natively and attach it. */
  async function captureRegion(rect: Rect) {
    setRegioning(true) // keep visual until capture; will flip below
    setSnapping(true)
    setRegioning(false) // remove the dim/box so it isn't captured
    try {
      await new Promise((r) => setTimeout(r, 120))
      const raw = await captureNative(rect)
      if (raw) {
        const dataUrl = await downscaleImage(raw).catch(() => raw)
        attachShot(dataUrl, `region-${nav.current}.png`)
      }
    } finally {
      setSnapping(false)
      setOpen(true)
    }
  }

  const ensureWorkspace = useCallback(async () => {
    if (workspaceId) return workspaceId
    const r = await ptyApi.listWorkspaces()
    const ws = r.workspaces.find((w) => w.cwd === METIS_ROOT)
      ?? (await ptyApi.createWorkspace({ name: 'metis-os', cwd: METIS_ROOT })).workspace
    setWorkspaceId(ws.id)
    return ws.id
  }, [workspaceId])

  // Resolve — or create — the metis-os workspace once per open so dispatched
  // builders run in the repo. (First live dispatch landed in $HOME because
  // only the default workspace existed and the old code fell back to it.)
  useEffect(() => {
    if (!open || workspaceId) return
    ensureWorkspace().catch(() => {})
  }, [ensureWorkspace, open, workspaceId])

  /** Deterministic dispatch — bypasses the assistant brain entirely. Spawns the
      builder with the full brief as initialPrompt (the proven startTask path),
      so a fix lands even when the brain stalls or fabricates a dispatch. */
  async function dispatchDirectly(request: string, modeId: string) {
    const targetWorkspaceId = await ensureWorkspace()
    const r = await ptyApi.spawnAgent({
      workspaceId: targetWorkspaceId,
      kind: 'codex',
      name: `annotate:${modeId}`,
      cwd: METIS_ROOT,
      role: 'builder',
      initialPrompt: [
        `UI fix request from Ant, annotated live on the "${modeById(modeId as Parameters<typeof modeById>[0]).label}" page of metis-command.`,
        `Request: ${request}`,
        `Likely files: ${(MODE_SOURCES[modeId] ?? []).map((s) => `projects/metis-command/${s}`).join(', ')}`,
        `Constraints: follow docs/design-guidelines.md; keep the change tightly scoped.`,
        `Verify with: cd projects/metis-command && npx tsc --noEmit && npm run lint.`,
        `Then commit via scripts/git-lock.sh run with an explicit pathspec and report what changed.`,
      ].join('\n'),
    })
    return r.agent.name
  }

  useEffect(() => {
    if (open) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [open, messages.length])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open])

  // Header AnnotateTrigger buttons open the shell-mounted panel via event —
  // no prop drilling through every mode component.
  useEffect(() => {
    const onOpen = () => setOpen(true)
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_EVENT, onOpen)
  }, [])

  async function send() {
    const trimmed = input.trim()
    if ((!trimmed && pending.length === 0) || busy) return
    const userMsg: Msg = {
      id: nanoid(),
      role: 'user',
      content: trimmed || '(see attached screenshot)',
      mode: nav.current,
      attachments: pending.length ? pending : undefined,
    }
    const next = [...messages, userMsg]
    persist(next)
    setInput('')
    setPending([])
    setBusy(true)
    try {
      // Page context rides inside the latest user message — the assistant API is
      // stateless per call, so each send re-frames where Ant currently is.
      // Attachments ship only on the latest message: the server persists images
      // per call, so re-sending history copies would duplicate files.
      const apiMessages = next.map((m, i) => ({
        role: m.role,
        content: m.role === 'user' && i === next.length - 1
          ? `${pageContextPreamble(m.mode ?? nav.current)}\n${m.content}`
          : m.content,
        attachments: i === next.length - 1 && m.attachments?.some((a) => a.dataUrl) ? m.attachments : undefined,
      }))
      const res = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ activeWorkspaceId: workspaceId, messages: apiMessages, auto: true }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        try {
          const name = await dispatchDirectly(trimmed || '(see attached screenshot)', userMsg.mode ?? nav.current)
          persist([...next, { id: nanoid(), role: 'assistant', content: `Assistant API failed (${data.error ?? res.statusText}), so I dispatched builder ${name} directly with the page brief.` }])
        } catch (e) {
          persist([...next, { id: nanoid(), role: 'assistant', content: `Error: ${data.error ?? res.statusText}; direct dispatch also failed: ${e instanceof Error ? e.message : 'unknown'}` }])
        }
      } else {
        let content = typeof data.message?.content === 'string' ? data.message.content : '(no response)'
        const toolCalls = data.toolCalls as Msg['toolCalls']
        // Honesty gate: the brain has replied "spawned a builder" without
        // actually calling spawn_agents (live failure 2026-06-10). Verify the
        // claim against the tool-call record and never present fake-done.
        const actuallySpawned = !!toolCalls?.some((tc) => tc.name === 'spawn_agents')
        const claimsDispatch = /spawn|dispatch/i.test(content)
        if (claimsDispatch && !actuallySpawned) {
          try {
            const name = await dispatchDirectly(trimmed || '(see attached screenshot)', userMsg.mode ?? nav.current)
            content += `\n\nNo assistant tool-call spawn was recorded, so I dispatched builder ${name} directly with the full brief.`
          } catch (e) {
            content += `\n\nNo agent was actually spawned (verified against the tool-call record), and direct dispatch failed: ${e instanceof Error ? e.message : 'unknown'}.`
          }
        }
        persist([...next, {
          id: nanoid(),
          role: 'assistant',
          content,
          toolCalls,
          direct: !actuallySpawned && !/dispatched builder/i.test(content) ? { request: trimmed || '(see screenshot)', mode: userMsg.mode ?? nav.current } : undefined,
        }])
      }
    } catch (e) {
      try {
        const name = await dispatchDirectly(trimmed || '(see attached screenshot)', userMsg.mode ?? nav.current)
        persist([...next, { id: nanoid(), role: 'assistant', content: `Assistant request failed, so I dispatched builder ${name} directly with the page brief.` }])
      } catch (directErr) {
        persist([...next, { id: nanoid(), role: 'assistant', content: `Error: ${e instanceof Error ? e.message : 'request failed'}; direct dispatch also failed: ${directErr instanceof Error ? directErr.message : 'unknown'}` }])
      }
    } finally {
      setBusy(false)
    }
  }

  // Workbench already embeds the full Assistant panel.
  if (nav.current === 'agents') return null

  const modeLabel = modeById(nav.current).label

  return (
    <>
      {/* Region-select overlay (desktop native capture) */}
      {regioning && <RegionOverlay onPick={captureRegion} onCancel={() => { setRegioning(false); setOpen(true) }} />}

      {/* FAB — mobile only (thumb zone, clear of the tab bar; Material 56px spec).
          Desktop's entry is the AnnotateTrigger in each mode header. */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label={`annotate the ${modeLabel} page`}
          data-testid="annotate-fab"
          data-annotate-ignore="true"
          className="fixed bottom-[108px] right-4 z-[60] flex h-14 w-14 items-center justify-center rounded-full border border-cyan-300/40 bg-[#0a1018]/95 text-cyan-200 shadow-[0_0_24px_rgba(52,211,255,0.25)] backdrop-blur-md transition-transform hover:scale-105 active:scale-95 md:hidden"
        >
          <MessageSquarePlus size={24} />
        </button>
      )}

      {open && (
        <div data-annotate-ignore="true" className="fixed inset-0 z-[70] flex items-end justify-end bg-black/50 md:items-stretch" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false) }}>
          <div
            data-testid="annotate-panel"
            className="flex max-h-[78vh] w-full flex-col overflow-hidden rounded-t-2xl border-t border-cyan-300/20 bg-[var(--panel)] shadow-2xl md:h-full md:max-h-none md:w-[400px] md:rounded-none md:border-l md:border-t-0"
          >
            <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] py-3 pl-2 pr-3">
              <button
                onClick={() => setOpen(false)}
                aria-label="close annotate"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--muted)] hover:bg-white/5 hover:text-slate-200"
              >
                <X size={20} />
              </button>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] md:text-[13px] font-black uppercase tracking-[0.16em] text-cyan-100">Annotate</div>
                <div className="truncate text-[12px] md:text-[11px] text-[var(--muted)]">about: {modeLabel} · fixes & features land via agents</div>
              </div>
              {messages.length > 0 && (
                <button
                  onClick={() => persist([])}
                  aria-label="clear annotate thread"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--muted)] hover:bg-white/5 hover:text-rose-300"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>

            <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3">
              {messages.length === 0 && (
                <div className="px-2 py-6 text-center text-[13px] md:text-[12px] text-[var(--muted)]">
                  Tell Metis what to fix or add on this page —<br />
                  “make the titles bigger”, “add a blocked-only filter”, “this card is redundant”.
                </div>
              )}
              {messages.map((m) => (
                <div key={m.id} className={`mb-2 flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] rounded-xl px-3 py-2 text-[13px] md:text-[12px] leading-relaxed ${
                    m.role === 'user'
                      ? 'border border-cyan-300/25 bg-cyan-300/10 text-cyan-50'
                      : 'border border-[var(--line)] bg-black/30 text-slate-200'
                  }`}>
                    {m.role === 'user' && m.mode && m.mode !== nav.current && (
                      <div className="mb-0.5 text-[11px] md:text-[10px] text-[var(--muted)]">on {modeById(m.mode as Parameters<typeof modeById>[0]).label}</div>
                    )}
                    {m.attachments && m.attachments.length > 0 && (
                      <div className="mb-1.5 flex flex-wrap gap-1.5">
                        {m.attachments.map((a, i) => a.dataUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img key={i} src={a.dataUrl} alt={a.name} className="max-h-28 rounded-lg border border-cyan-300/20" />
                        ) : (
                          <span key={i} className="flex items-center gap-1 rounded-md border border-[var(--line)] bg-black/30 px-2 py-1 text-[11px] md:text-[10px] text-[var(--muted)]">
                            <Camera size={12} /> {a.name}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="whitespace-pre-wrap">{m.content}</div>
                    {m.toolCalls && m.toolCalls.length > 0 && (
                      <div className="mt-1.5 border-t border-[var(--line)] pt-1.5 text-[12px] md:text-[10px] text-[var(--muted)]">
                        {m.toolCalls.map((tc, i) => <div key={i} className="truncate">⚙ {tc.name}</div>)}
                        {m.toolCalls.some((tc) => tc.name.includes('spawn')) && (
                          <button
                            onClick={() => { setOpen(false); nav.goto('agents') }}
                            className="mt-1 flex items-center gap-1 rounded-lg border border-cyan-300/30 bg-cyan-300/10 px-2.5 py-1.5 text-[12px] md:text-[10px] font-bold text-cyan-100 hover:bg-cyan-300/20"
                          >
                            <Bot size={12} /> watch in Agents
                          </button>
                        )}
                      </div>
                    )}
                    {m.direct && (
                      <button
                        onClick={async () => {
                          try {
                            const name = await dispatchDirectly(m.direct!.request, m.direct!.mode)
                            persist([...messages.map((x) => x.id === m.id ? { ...x, direct: undefined } : x),
                              { id: nanoid(), role: 'assistant' as const, content: `⚡ Builder ${name} dispatched directly with the full brief — watch it in Agents.` }])
                          } catch (e) {
                            persist([...messages, { id: nanoid(), role: 'assistant' as const, content: `Error: direct dispatch failed — ${e instanceof Error ? e.message : 'unknown'}` }])
                          }
                        }}
                        className="mt-1.5 flex items-center gap-1.5 rounded-lg border border-amber-300/40 bg-amber-300/10 px-2.5 py-1.5 text-[12px] md:text-[10px] font-bold text-amber-200 hover:bg-amber-300/20"
                      >
                        <Bot size={12} /> dispatch builder directly
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {busy && <MetisLoader size={18} label="Métis is working…" inline className="px-2 py-1 text-[13px] md:text-[11px]" />}
            </div>

            <div className="shrink-0 border-t border-[var(--line)] p-3 pb-[max(env(safe-area-inset-bottom),12px)]">
              {pending.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {pending.map((a, i) => (
                    <div key={i} className="relative">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={a.dataUrl} alt={a.name} className="h-16 rounded-lg border border-cyan-300/25" />
                      <button
                        onClick={() => setPending((p) => p.filter((_, j) => j !== i))}
                        aria-label={`remove ${a.name}`}
                        className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full border border-rose-300/40 bg-[var(--panel)] text-rose-300 hover:bg-rose-300/20"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex items-end gap-2">
                <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />
                <button
                  onClick={snapPage}
                  disabled={snapping}
                  aria-label="snap a screenshot of this page"
                  title={hasNative ? 'Snap this page — native capture (renders terminals/feeds)' : 'Snap this page — captures the screen behind the panel'}
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-[var(--line)] bg-black/40 text-slate-300 hover:border-cyan-300/40 hover:text-cyan-100 disabled:opacity-40"
                >
                  {snapping ? <Loader2 size={20} className="animate-spin" /> : <Camera size={20} />}
                </button>
                {hasNative && (
                  <button
                    onClick={startRegion}
                    disabled={snapping}
                    aria-label="grab a region of the screen"
                    title="Grab a region — drag to box exactly what to annotate"
                    className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-[var(--line)] bg-black/40 text-slate-300 hover:border-cyan-300/40 hover:text-cyan-100 disabled:opacity-40"
                  >
                    <Crop size={20} />
                  </button>
                )}
                <button
                  onClick={() => fileRef.current?.click()}
                  aria-label="attach a screenshot or photo"
                  title="Attach an image (photo library / camera)"
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-[var(--line)] bg-black/40 text-slate-300 hover:border-cyan-300/40 hover:text-cyan-100"
                >
                  <Paperclip size={20} />
                </button>
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
                  onPaste={(e) => {
                    const files = Array.from(e.clipboardData?.items ?? [])
                      .filter((i) => i.kind === 'file')
                      .map((i) => i.getAsFile())
                      .filter((f): f is File => !!f && f.type.startsWith('image/'))
                    if (files.length) { e.preventDefault(); addFiles(files) }
                  }}
                  placeholder={`Fix or add something on ${modeLabel}…`}
                  rows={2}
                  className="min-h-[48px] min-w-0 flex-1 resize-none rounded-xl border border-[var(--line)] bg-black/40 px-3 py-2.5 text-[15px] md:text-[13px] text-slate-200 placeholder-[var(--muted)] focus:border-cyan-300/40 focus:outline-none"
                />
                <button
                  onClick={send}
                  disabled={busy || (!input.trim() && pending.length === 0)}
                  aria-label="send annotation"
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-cyan-300/40 bg-cyan-300/10 text-cyan-100 hover:bg-cyan-300/20 disabled:opacity-40"
                >
                  {busy ? <Loader2 size={20} className="animate-spin" /> : <Send size={20} />}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
