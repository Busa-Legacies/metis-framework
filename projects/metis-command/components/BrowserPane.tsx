'use client'

import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, RefreshCw, X, Globe, Camera } from 'lucide-react'

interface Props {
  url: string
  onChangeUrl: (url: string) => void
  onClose: () => void
  onCapture?: (rect: DOMRect) => void
}

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

export default function BrowserPane({ url, onChangeUrl, onClose, onCapture }: Props) {
  const [draft, setDraft] = useState(url)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const captureAreaRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => { setDraft(url) }, [url])

  function reload() {
    const f = iframeRef.current
    if (!f) return
    try { f.src = f.src } catch {}
  }

  return (
    <div className="flex h-full flex-col bg-black/50">
      <header className="flex items-center gap-1 border-b border-slate-400/10 bg-black/30 px-2 py-1.5">
        <Globe size={12} className="text-cyan-300" />
        <button onClick={() => iframeRef.current?.contentWindow?.history?.back()} className="rounded p-1 text-slate-400 hover:text-white" title="back"><ArrowLeft size={12} /></button>
        <button onClick={() => iframeRef.current?.contentWindow?.history?.forward()} className="rounded p-1 text-slate-400 hover:text-white" title="forward"><ArrowRight size={12} /></button>
        <button onClick={reload} className="rounded p-1 text-slate-400 hover:text-white" title="reload"><RefreshCw size={14} /></button>
        {onCapture && typeof window !== 'undefined' && (window as any).aw?.isElectron && (
          <button
            onClick={() => { const el = captureAreaRef.current; if (el) onCapture(el.getBoundingClientRect()) }}
            className="rounded p-1 text-slate-400 hover:text-cyan-200"
            title="screenshot → assistant"
          ><Camera size={12} /></button>
        )}
        <form
          className="flex-1"
          onSubmit={(e) => { e.preventDefault(); const norm = normalizeUrl(draft); if (norm) onChangeUrl(norm) }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="localhost:3000 or https://…"
            className="w-full rounded-md border border-slate-400/15 bg-black/40 px-2 py-1 text-xs text-white placeholder:text-slate-500 focus:border-cyan-300/40 focus:outline-none"
          />
        </form>
        <button onClick={onClose} className="rounded p-1 text-slate-400 hover:text-rose-300" title="close browser"><X size={12} /></button>
      </header>
      <div ref={captureAreaRef} className="relative flex-1">
        {url ? (
          <iframe
            ref={iframeRef}
            src={url}
            className="absolute inset-0 h-full w-full bg-white"
            sandbox="allow-forms allow-popups allow-presentation allow-same-origin allow-scripts allow-modals"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-slate-500">enter a URL above</div>
        )}
      </div>
    </div>
  )
}
