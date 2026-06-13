'use client'

import { useEffect, useState } from 'react'
import { MessageSquare, Send, Trash2, CheckCircle2, AlertTriangle, RefreshCw, Crosshair, X } from 'lucide-react'
import { useReviewStore, annotationsToPrompt, type Annotation } from '@/lib/review-store'
import { ptyApi, fetchCropObjectUrl } from '@/lib/pty-client'

const SEVERITY_COLOR: Record<Annotation['severity'], string> = {
  note: 'text-slate-400',
  issue: 'text-amber-300',
  blocker: 'text-rose-400',
}

// #259: the sidecar is token-gated and <img> can't send headers — fetch the
// crop PNG authenticated and render it via a (revoked-on-unmount) object URL.
function CropThumb({ cropSlug, annotationId, comment }: { cropSlug: string; annotationId: string; comment: string }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let revoked = false
    let objectUrl: string | null = null
    fetchCropObjectUrl(cropSlug, annotationId)
      .then((u) => {
        if (revoked) URL.revokeObjectURL(u)
        else {
          objectUrl = u
          setSrc(u)
        }
      })
      .catch(() => setSrc(null))
    return () => {
      revoked = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [cropSlug, annotationId])
  if (!src) return null
  return (
    // eslint-disable-next-line @next/next/no-img-element -- authed blob URL, not a Next asset
    <img
      src={src}
      alt={`pin-time crop: ${comment}`}
      className="mt-1.5 max-h-24 w-full rounded border border-slate-400/15 object-contain object-left bg-black/30"
      loading="lazy"
    />
  )
}

function verifyTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function AnnotationRail() {
  const annotations = useReviewStore((s) => s.annotations)
  const updateAnnotation = useReviewStore((s) => s.updateAnnotation)
  const removeAnnotation = useReviewStore((s) => s.removeAnnotation)
  const url = useReviewStore((s) => s.url)
  const agentId = useReviewStore((s) => s.agentId)
  const sessionPath = useReviewStore((s) => s.sessionPath)
  const awaitingAgent = useReviewStore((s) => s.awaitingAgent)
  const lastVerify = useReviewStore((s) => s.lastVerify)
  const repickId = useReviewStore((s) => s.repickId)
  const setRepick = useReviewStore((s) => s.setRepick)

  const actionable = annotations.filter((a) => a.status === 'open' || a.status === 'changed')

  async function sendToAgent() {
    if (!agentId || actionable.length === 0) return
    const prompt = annotationsToPrompt(annotations, url, sessionPath)
    await ptyApi.sendInput(agentId, prompt + '\n')
    // Arm the round-trip verify watcher (#258): when the agent's run completes,
    // the preview reloads and every pin re-verifies automatically.
    useReviewStore.getState().setAwaitingAgent(true)
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-slate-400/10 bg-[rgba(5,6,10,0.92)] px-3 py-2">
        <MessageSquare size={12} className="text-cyan-300" />
        <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">Annotations</span>
        <span className="ml-auto text-[10px] text-slate-500">{actionable.length} open</span>
        <button
          onClick={sendToAgent}
          disabled={!agentId || actionable.length === 0}
          className="flex items-center gap-1 rounded bg-cyan-400/15 px-2 py-1 text-[10px] uppercase tracking-wider text-cyan-300 enabled:hover:bg-cyan-400/25 disabled:opacity-40"
          title={agentId ? 'send open annotations to agent' : 'spawn an agent first'}
        >
          <Send size={10} /> to agent
        </button>
      </header>
      {(repickId || awaitingAgent || lastVerify) && (
        <div className="flex items-center gap-1.5 border-b border-slate-400/10 bg-[rgba(11,14,21,0.6)] px-3 py-1">
          {repickId ? (
            <>
              <Crosshair size={10} className="text-cyan-300" />
              <span className="text-[10px] uppercase tracking-wider text-cyan-300">re-picking — click the replacement element in the preview</span>
              <button onClick={() => setRepick(null)} className="ml-auto rounded p-0.5 text-slate-400 hover:text-white" title="cancel re-pick">
                <X size={11} />
              </button>
            </>
          ) : awaitingAgent ? (
            <>
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400" />
              <span className="text-[10px] uppercase tracking-wider text-violet-300">awaiting agent — auto-verify on completion</span>
            </>
          ) : lastVerify && (
            <>
              <RefreshCw size={10} className="text-cyan-300" />
              <span className="text-[10px] text-slate-400">
                verified {verifyTime(lastVerify.ts)}{lastVerify.trigger === 'auto' ? ' (auto)' : ''} —{' '}
                {lastVerify.counts.changed > 0 && <span className="text-amber-300">{lastVerify.counts.changed} changed · </span>}
                {lastVerify.counts.open} open · {lastVerify.counts.orphaned} orphaned
                {lastVerify.counts.resolved > 0 && ` · ${lastVerify.counts.resolved} resolved`}
              </span>
            </>
          )}
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-2">
        {annotations.length === 0 ? (
          <div className="mt-8 text-center text-xs text-slate-500">
            arm the picker and click an element to pin a comment
          </div>
        ) : (
          annotations.map((a) => (
            <div key={a.id} className="mb-2 rounded-md border border-slate-400/15 bg-[rgba(11,14,21,0.7)] p-2">
              <div className="flex items-center gap-1.5">
                {a.status === 'orphaned' && <AlertTriangle size={11} className="text-amber-400" />}
                {a.status === 'changed' && <RefreshCw size={11} className="text-cyan-400" />}
                <span className={`text-[10px] uppercase tracking-wider ${SEVERITY_COLOR[a.severity]}`}>{a.severity}</span>
                {a.status === 'changed' && <span className="rounded border border-cyan-400/30 bg-cyan-400/10 px-1 text-[9px] uppercase tracking-wider text-cyan-300">changed</span>}
                <span className="ml-auto flex gap-1">
                  {a.status === 'orphaned' && (
                    <button
                      onClick={() => setRepick(repickId === a.id ? null : a.id)}
                      className={`rounded p-0.5 ${repickId === a.id ? 'text-cyan-300' : 'text-slate-500 hover:text-cyan-300'}`}
                      title="re-pick: re-attach this comment to a new element"
                    >
                      <Crosshair size={12} />
                    </button>
                  )}
                  <button
                    onClick={() => updateAnnotation(a.id, { status: a.status === 'resolved' ? 'open' : 'resolved' })}
                    className={`rounded p-0.5 ${a.status === 'resolved' ? 'text-emerald-400' : 'text-slate-500 hover:text-emerald-300'}`}
                    title="toggle resolved"
                  >
                    <CheckCircle2 size={12} />
                  </button>
                  <button onClick={() => removeAnnotation(a.id)} className="rounded p-0.5 text-slate-500 hover:text-rose-300" title="delete">
                    <Trash2 size={12} />
                  </button>
                </span>
              </div>
              <p className={`mt-1 text-xs ${a.status === 'resolved' ? 'text-slate-500 line-through' : 'text-slate-200'}`}>{a.comment}</p>
              <code className="mt-1 block truncate text-[10px] text-cyan-300/70" title={a.selector}>{a.selector}</code>
              {a.cropSlug && <CropThumb cropSlug={a.cropSlug} annotationId={a.id} comment={a.comment} />}
              {a.status === 'changed' && a.verifiedStyles && (
                <div className="mt-1.5 rounded border border-cyan-400/20 bg-cyan-400/5 p-1.5 text-[10px]">
                  {Object.keys(a.styles).filter((k) => a.styles[k] !== a.verifiedStyles![k]).map((k) => (
                    <div key={k} className="flex items-baseline gap-1 truncate">
                      <span className="shrink-0 text-slate-500">{k}:</span>
                      <span className="text-rose-300 line-through truncate">{a.styles[k]}</span>
                      <span className="shrink-0 text-slate-500">→</span>
                      <span className="text-emerald-300 truncate">{a.verifiedStyles![k]}</span>
                    </div>
                  ))}
                  {a.verifiedText !== undefined && (
                    <div className="flex items-baseline gap-1 truncate">
                      <span className="shrink-0 text-slate-500">text:</span>
                      <span className="text-rose-300 line-through truncate">{a.text}</span>
                      <span className="shrink-0 text-slate-500">→</span>
                      <span className="text-emerald-300 truncate">{a.verifiedText}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
