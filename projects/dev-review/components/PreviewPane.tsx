'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, RotateCw, Globe, Crosshair, RefreshCw, Eye } from 'lucide-react'
import { useReviewStore } from '@/lib/review-store'
import { ptyApi } from '@/lib/pty-client'
import { createOverlayController, type OverlayController, type PickResult } from '@/lib/overlay-controller'

function normalizeUrl(input: string): string {
  const t = input.trim()
  if (!t) return ''
  if (/^https?:\/\//i.test(t)) return t
  if (/^localhost(:\d+)?(\/|$)/.test(t)) return `http://${t}`
  if (/^\d+\.\d+\.\d+\.\d+(:\d+)?(\/|$)/.test(t)) return `http://${t}`
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(t)) return `https://${t}`
  // bare port like 3000 or :3000 → localhost:port
  const portOnly = t.replace(/^:/, '')
  if (/^\d+$/.test(portOnly)) return `http://localhost:${portOnly}`
  return t
}

/**
 * Preview of the app under review. Same-origin localhost targets get the
 * annotation overlay injected (step 2 of the plan — picker + pins live in
 * lib/overlay-script). Cross-origin pages render but cannot be annotated.
 */
export default function PreviewPane() {
  const url = useReviewStore((s) => s.url)
  const setUrl = useReviewStore((s) => s.setUrl)
  const picking = useReviewStore((s) => s.picking)
  const setPicking = useReviewStore((s) => s.setPicking)
  const annotations = useReviewStore((s) => s.annotations)
  const addAnnotation = useReviewStore((s) => s.addAnnotation)
  const [draft, setDraft] = useState(url)
  const [pendingPick, setPendingPick] = useState<PickResult | null>(null)
  const [comment, setComment] = useState('')
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const controllerRef = useRef<OverlayController | null>(null)
  useEffect(() => { setDraft(url) }, [url])

  // Same-origin proxy handshake (see middleware.ts): the iframe loads
  // /__preview on OUR origin; middleware forwards to the target held in the
  // dr-target cookie. Direct cross-port iframing would be cross-origin and
  // kill contentDocument access for the overlay.
  const [previewSrc, setPreviewSrc] = useState('')
  useEffect(() => {
    if (!url) { setPreviewSrc(''); return }
    try {
      const u = new URL(url)
      document.cookie = `dr-target=${u.origin}; path=/; SameSite=Lax`
      // Carry the origin in the query so previewSrc CHANGES when the target
      // changes — the iframe remounts via key={previewSrc}. Without it, a
      // target whose first load redirected the iframe away (e.g. a root 307
      // to another port) was unrecoverable: every later URL submit produced
      // the same '/__preview' string and React never reloaded the frame.
      const marker = `dr=${encodeURIComponent(u.origin)}`
      setPreviewSrc(u.pathname === '/'
        ? `/__preview${u.search ? `${u.search}&${marker}` : `?${marker}`}`
        : `${u.pathname}${u.search}`)
    } catch {
      setPreviewSrc('')
    }
  }, [url])

  // Overlay controller lifecycle — recreate when the iframe (re)mounts on URL change.
  const mountIframe = useCallback((node: HTMLIFrameElement | null) => {
    iframeRef.current = node
    controllerRef.current?.dispose()
    controllerRef.current = null
    if (!node) return
    controllerRef.current = createOverlayController(node, {
      onPick: (r) => {
        const { repickId, url: currentUrl } = useReviewStore.getState()
        if (repickId) {
          // Rebind (#257): a re-pick keeps the comment/severity (the review work)
          // and refreshes the anchor data; verify residue from the dead anchor is
          // cleared. Same annotation id ⇒ the crop file is overwritten in place.
          useReviewStore.getState().updateAnnotation(repickId, {
            selector: r.selector, rect: r.rect, styles: r.styles, text: r.text,
            status: 'open', verifiedStyles: undefined, verifiedText: undefined,
          })
          ptyApi.captureCrop({ url: currentUrl, selector: r.selector, annotationId: repickId })
            .then((res) => useReviewStore.getState().updateAnnotation(repickId, { cropPath: res.path, cropSlug: res.slug }))
            .catch(() => {})
          useReviewStore.getState().setRepick(null)
          return
        }
        setPendingPick(r)
        useReviewStore.getState().setPicking(false)
      },
      onOrphan: (ids) => ids.forEach((id) => useReviewStore.getState().updateAnnotation(id, { status: 'orphaned' })),
    })
  }, [])

  useEffect(() => { controllerRef.current?.setPicking(picking) }, [picking])
  useEffect(() => {
    controllerRef.current?.renderPins(annotations.map((a) => ({ id: a.id, selector: a.selector, status: a.status })))
  }, [annotations])
  useEffect(() => () => controllerRef.current?.dispose(), [])

  function commitPick() {
    if (!pendingPick || !comment.trim()) return
    const ann = addAnnotation({ ...pendingPick, comment: comment.trim(), url, severity: 'issue' })
    // Pin-time element crop (#256) — fire-and-forget; a capture failure never
    // blocks pinning, the annotation simply carries no crop.
    ptyApi.captureCrop({ url, selector: ann.selector, annotationId: ann.id })
      .then((r) => useReviewStore.getState().updateAnnotation(ann.id, { cropPath: r.path, cropSlug: r.slug }))
      .catch(() => {})
    setPendingPick(null)
    setComment('')
  }

  function reload() {
    const f = iframeRef.current
    if (!f) return
    try { f.src = f.src } catch {}
  }

  function verify(trigger: 'auto' | 'manual' | 'load' = 'manual') {
    const doc = iframeRef.current?.contentDocument
    if (doc) useReviewStore.getState().verifyAll(doc, trigger)
  }

  // Round-trip verify (#258): a bumped verifyRequestId asks for reload-then-verify.
  // The reload's onLoad handler runs the verify pass against the fresh document;
  // 'load' would mislabel the trigger, so the request is remembered and consumed.
  const verifyRequestId = useReviewStore((s) => s.verifyRequestId)
  const pendingAutoVerify = useRef(false)
  const lastVerifyRequest = useRef(0)
  useEffect(() => {
    if (verifyRequestId === lastVerifyRequest.current) return
    lastVerifyRequest.current = verifyRequestId
    pendingAutoVerify.current = true
    reload()
  }, [verifyRequestId])

  function onIframeLoad() {
    const trigger = pendingAutoVerify.current ? 'auto' : 'load'
    pendingAutoVerify.current = false
    verify(trigger)
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-1 border-b border-slate-400/10 bg-[rgba(5,6,10,0.92)] px-2 py-1.5">
        <Eye size={12} className="text-cyan-300" />
        <span className="mr-1 text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">Preview</span>
        <div className="mx-1.5 h-3 w-px bg-slate-700/80" />
        <Globe size={12} className="text-slate-500" />
        <button onClick={() => iframeRef.current?.contentWindow?.history?.back()} className="rounded p-1 text-slate-400 hover:text-white" title="back"><ArrowLeft size={12} /></button>
        <button onClick={() => iframeRef.current?.contentWindow?.history?.forward()} className="rounded p-1 text-slate-400 hover:text-white" title="forward"><ArrowRight size={12} /></button>
        <button onClick={reload} className="rounded p-1 text-slate-400 hover:text-white" title="reload"><RotateCw size={12} /></button>
        <button onClick={() => verify('manual')} className="rounded p-1 text-slate-400 hover:text-cyan-200" title="re-run selectors and check for changes"><RefreshCw size={12} /></button>
        <form
          className="flex-1"
          onSubmit={(e) => { e.preventDefault(); const norm = normalizeUrl(draft); if (norm) setUrl(norm) }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="localhost:8080 or https://…"
            className="w-full rounded-md border border-slate-400/15 bg-black/40 px-2 py-1 text-xs text-white placeholder:text-slate-500 focus:border-cyan-300/40 focus:outline-none"
          />
        </form>
        <button
          onClick={() => setPicking(!picking)}
          className={`flex items-center gap-1 rounded px-1.5 py-1 text-[10px] uppercase tracking-wider ${picking ? 'bg-cyan-400/20 text-cyan-300' : 'text-slate-400 hover:text-white'}`}
          title="toggle element picker"
        >
          <Crosshair size={12} /> pick
        </button>
      </header>
      <div className="relative flex-1">
        {previewSrc ? (
          <iframe
            key={previewSrc}
            ref={mountIframe}
            src={previewSrc}
            className="absolute inset-0 h-full w-full bg-white"
            sandbox="allow-forms allow-popups allow-presentation allow-same-origin allow-scripts allow-modals"
            onLoad={onIframeLoad}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-slate-500">enter a URL above</div>
        )}
        {pendingPick && (
          <div className="absolute inset-x-0 bottom-0 border-t border-cyan-300/30 bg-black/90 p-3">
            <code className="block truncate text-[10px] text-cyan-300/80" title={pendingPick.selector}>{pendingPick.selector}</code>
            <form
              className="mt-2 flex gap-2"
              onSubmit={(e) => { e.preventDefault(); commitPick() }}
            >
              <input
                autoFocus
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="what's wrong / what should change…"
                className="flex-1 rounded-md border border-slate-400/15 bg-black/40 px-2 py-1.5 text-xs text-white placeholder:text-slate-500 focus:border-cyan-300/40 focus:outline-none"
              />
              <button type="submit" disabled={!comment.trim()} className="rounded bg-cyan-400/20 px-3 py-1.5 text-[10px] uppercase tracking-wider text-cyan-300 enabled:hover:bg-cyan-400/30 disabled:opacity-40">pin</button>
              <button type="button" onClick={() => { setPendingPick(null); setComment('') }} className="rounded px-2 py-1.5 text-[10px] uppercase tracking-wider text-slate-400 hover:text-white">cancel</button>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}
