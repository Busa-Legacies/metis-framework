'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Loader2, Check, X } from 'lucide-react'

export interface ActionResult {
  ok: boolean
  msg: string
}

/**
 * Confirm-gated action button — the shared §8.6 pattern for shared-state /
 * external actions (restart service, claim/finish task). Click → confirm dialog
 * (with the exact consequence) → run governed action → show ok/error result +
 * any evidence (log tail). Read paths never use this; only mutations do.
 */
export function ConfirmActionButton({
  label,
  title,
  body,
  confirmLabel = 'Confirm',
  danger = false,
  run,
}: {
  label: React.ReactNode
  title: string
  body: string
  confirmLabel?: string
  danger?: boolean
  run: () => Promise<ActionResult>
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ActionResult | null>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  const onConfirm = async () => {
    setBusy(true)
    setResult(null)
    const r = await run()
    setResult(r)
    setBusy(false)
  }

  const close = () => {
    if (busy) return
    setOpen(false)
    setResult(null)
  }

  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(true) }}
        className={`flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1 text-sm md:text-[11px] font-bold ${
          danger
            ? 'border-rose-300/40 bg-rose-300/10 text-rose-200 hover:bg-rose-300/20'
            : 'border-cyan-300/40 bg-cyan-300/10 text-cyan-100 hover:bg-cyan-300/20'
        }`}
      >
        {label}
      </button>

      {open && mounted && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={close}>
          <div className="panel w-full max-w-sm rounded-xl p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center gap-2">
              <AlertTriangle size={16} className={danger ? 'text-rose-200' : 'text-cyan-200'} />
              <span className="text-[17px] md:text-sm font-black uppercase tracking-[0.16em] text-slate-100">{title}</span>
            </div>
            <p className="mb-3 text-[15px] md:text-xs text-slate-300">{body}</p>

            {result ? (
              <div className={`mb-3 rounded-lg border p-2 text-sm md:text-[11px] ${result.ok ? 'border-emerald-300/30 bg-emerald-300/5 text-emerald-200' : 'border-rose-300/30 bg-rose-300/5 text-rose-200'}`}>
                <div className="flex items-center gap-1 font-bold">
                  {result.ok ? <Check size={12} /> : <X size={12} />} {result.ok ? 'Done' : 'Failed'}
                </div>
                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[13px] md:text-[10px] text-slate-400">{result.msg}</pre>
              </div>
            ) : null}

            <div className="flex justify-end gap-2">
              <button onClick={close} disabled={busy} className="rounded-lg border border-slate-400/20 bg-black/30 px-3 py-1 text-[15px] md:text-xs text-slate-300 hover:text-white disabled:opacity-50">
                {result ? 'Close' : 'Cancel'}
              </button>
              {!result && (
                <button
                  onClick={onConfirm}
                  disabled={busy}
                  className={`flex items-center gap-1 rounded-lg border px-3 py-1 text-[15px] md:text-xs font-bold disabled:opacity-50 ${
                    danger ? 'border-rose-300/40 bg-rose-300/10 text-rose-200 hover:bg-rose-300/20' : 'border-cyan-300/40 bg-cyan-300/10 text-cyan-100 hover:bg-cyan-300/20'
                  }`}
                >
                  {busy ? <Loader2 size={12} className="animate-spin" /> : null} {confirmLabel}
                </button>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
