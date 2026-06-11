'use client'

import { MessageSquare, Send, Trash2, CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-react'
import { useReviewStore, annotationsToPrompt, type Annotation } from '@/lib/review-store'
import { ptyApi } from '@/lib/pty-client'

const SEVERITY_COLOR: Record<Annotation['severity'], string> = {
  note: 'text-slate-400',
  issue: 'text-amber-300',
  blocker: 'text-rose-400',
}

export default function AnnotationRail() {
  const annotations = useReviewStore((s) => s.annotations)
  const updateAnnotation = useReviewStore((s) => s.updateAnnotation)
  const removeAnnotation = useReviewStore((s) => s.removeAnnotation)
  const url = useReviewStore((s) => s.url)
  const agentId = useReviewStore((s) => s.agentId)
  const sessionPath = useReviewStore((s) => s.sessionPath)

  const actionable = annotations.filter((a) => a.status === 'open' || a.status === 'changed')

  async function sendToAgent() {
    if (!agentId || actionable.length === 0) return
    const prompt = annotationsToPrompt(annotations, url, sessionPath)
    await ptyApi.sendInput(agentId, prompt + '\n')
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
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
